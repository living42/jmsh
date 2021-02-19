package jmsh

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io/ioutil"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"

	"github.com/gorilla/websocket"
	"github.com/mattn/go-tty"
)

// Client for interact with Jumpserver
type Client struct {
	endpoint *url.URL
	*http.Client
}

// NewClient creates client
func NewClient(endpoint string) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &Client{endpoint: u, Client: &http.Client{Jar: jar}}, nil
}

// FetchLoginPage access and get csrftoken rsa public key
func (c *Client) FetchLoginPage() (*LoginPage, error) {
	r, err := c.Get(c.endpoint.String() + "/core/auth/login/")
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()

	content, err := ioutil.ReadAll(r.Body)
	text := string(content)

	if r.StatusCode != 200 {
		return nil, fmt.Errorf("access login page got %s", r.Status)
	}

	m := regexp.MustCompile(`name="csrfmiddlewaretoken"\s*?value="(.+?)"`).FindStringSubmatch(text)
	if len(m) == 0 {
		return nil, fmt.Errorf("failed to get csrftoken")
	}
	csrftoken := m[1]

	m = regexp.MustCompile(`var rsaPublicKey = (".+")`).FindStringSubmatch(text)
	if len(m) == 0 {
		return nil, fmt.Errorf("failed to get rsaPublicKey")
	}

	var pubKeyText string
	if err := json.Unmarshal([]byte(m[1]), &pubKeyText); err != nil {
		return nil, fmt.Errorf("failed to parse rsaPublicKey in json form: %s", err)
	}

	block, _ := pem.Decode([]byte(pubKeyText))
	pubKey, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse rsaPublicKey in pem form: %s", err)
	}
	rsaPublicKey, ok := pubKey.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("invalid rsaPublicKey on login page")
	}

	var captcha0 string
	var captchaImg string
	m = regexp.MustCompile(`name="captcha_0"\s*?value="(.+?)"`).FindStringSubmatch(text)
	if len(m) > 0 {
		captcha0 = m[1]
		captchaImg = c.endpoint.String() + "/core/auth/captcha/image/" + captcha0 + "/"
	}

	return &LoginPage{
		csrftoken:    csrftoken,
		rsaPublicKey: rsaPublicKey,
		captcha0:     captcha0,
		captchaImg:   captchaImg,
		client:       c,
	}, nil
}

// LoginPage store infomation about login page
type LoginPage struct {
	csrftoken    string
	rsaPublicKey *rsa.PublicKey
	captcha0     string
	captchaImg   string
	client       *Client
}

// HasCaptcha indicate this page contain captcha
func (lp *LoginPage) HasCaptcha() bool {
	return lp.captcha0 != ""
}

func (lp *LoginPage) FetchCaptcha() ([]byte, error) {
	u := lp.client.endpoint.String() + "/core/auth/captcha/image/" + lp.captcha0 + "/"

	r, err := lp.client.Get(u)
	if err != nil {
		return nil, err
	}
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("failed to fetch captcha: %s", r.Status)
	}

	return ioutil.ReadAll(r.Body)
}

// ErrLoginFailed indicate authentication error
var ErrLoginFailed = errors.New("ErrLoginFailed")

// Submit submits login form to Jumpserver
func (lp *LoginPage) Submit(username, password, captcha string) (*LoginResult, error) {
	form := url.Values{}
	form.Set("csrfmiddlewaretoken", lp.csrftoken)
	form.Set("username", username)

	encryptedPassword, err := rsa.EncryptPKCS1v15(
		rand.Reader, lp.rsaPublicKey, []byte(password))
	if err != nil {
		return nil, err
	}

	form.Set("password", base64.StdEncoding.EncodeToString(encryptedPassword))
	if captcha != "" {
		form.Set("captcha_0", lp.captcha0)
		form.Set("captcha_1", captcha)
	}

	r, err := lp.client.PostForm(lp.client.endpoint.String()+"/core/auth/login/", form)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()

	content, err := ioutil.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	text := string(content)

	if r.StatusCode != 200 {
		return nil, fmt.Errorf("submit login form got %s", r.Status)
	}

	if r.Request.URL.Path != "/" {
		if r.Request.URL.Path == "/core/auth/login/otp/" {
			m := regexp.MustCompile(`name="csrfmiddlewaretoken"\s*?value="(.+?)"`).FindStringSubmatch(text)
			if len(m) == 0 {
				return nil, fmt.Errorf("failed to get csrftoken")
			}
			csrftoken := m[1]
			return &LoginResult{client: lp.client, hasOTP: true, csrftoken: csrftoken}, ErrLoginFailed
		}
		return &LoginResult{}, ErrLoginFailed
	}

	return &LoginResult{}, nil
}

// LoginResult stores result of submit result of login page
type LoginResult struct {
	client    *Client
	hasOTP    bool
	csrftoken string
}

func (lr *LoginResult) HasOTP() bool {
	return lr.hasOTP
}

func (lr *LoginResult) SubmitOTP(otp string) (*LoginResult, error) {
	form := url.Values{}
	form.Set("csrfmiddlewaretoken", lr.csrftoken)
	form.Set("otp_code", otp)

	r, err := lr.client.PostForm(lr.client.endpoint.String()+"/core/auth/login/otp/", form)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()

	content, err := ioutil.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	text := string(content)

	if r.StatusCode != 200 {
		return nil, fmt.Errorf("submit otp form got %s", r.Status)
	}

	if r.Request.URL.Path != "/" {
		if r.Request.URL.Path == "/core/auth/login/otp/" {
			m := regexp.MustCompile(`name="csrfmiddlewaretoken"\s*?value="(.+?)"`).FindStringSubmatch(text)
			if len(m) == 0 {
				return nil, fmt.Errorf("failed to get csrftoken")
			}
			csrftoken := m[1]
			return &LoginResult{hasOTP: true, csrftoken: csrftoken}, ErrLoginFailed
		}
		return &LoginResult{}, ErrLoginFailed
	}

	return &LoginResult{}, nil
}

type Asset struct {
	ID       string   `json:"id"`
	Hostname string   `json:"hostname"`
	Nodes    []string `json:"nodes_display"`
}

type SystemUser struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username"`
}

func (c *Client) FindAssetByHostname(hostname string) (Asset, bool, error) {
	if hostname == "" {
		return Asset{}, false, fmt.Errorf("hostname must not be empty")
	}

	req, err := http.NewRequest("GET", c.endpoint.String()+"/api/v1/assets/assets/", nil)
	if err != nil {
		return Asset{}, false, err
	}
	query := url.Values{}
	query.Set("hostname", hostname)
	query.Set("offset", "0")
	query.Set("limit", "100")
	query.Set("display", "1")
	query.Set("draw", "1")
	req.URL.RawQuery = query.Encode()

	r, err := c.Do(req)
	if err != nil {
		return Asset{}, false, err
	}
	defer r.Body.Close()
	content, err := ioutil.ReadAll(r.Body)
	if err != nil {
		return Asset{}, false, err
	}

	if r.StatusCode != 200 {
		return Asset{}, false, fmt.Errorf("api request failed: %s", r.Status)
	}

	var result struct {
		Results []Asset `json:"results"`
	}

	if err := json.Unmarshal(content, &result); err != nil {
		return Asset{}, false, err
	}

	if len(result.Results) == 0 {
		return Asset{}, false, nil
	}

	if result.Results[0].Hostname != hostname {
		return Asset{}, false, fmt.Errorf(
			"expected asset %s, but got %s", hostname, result.Results[0].Hostname)
	}
	return result.Results[0], true, nil
}

// func (c *Client) SearchAsset(keyword string) ([]Asset, error) {
// 	var (
// 		assets []Asset
// 		offset int = 0
// 		limit  int = 100
// 	)

// 	for {
// 		u := fmt.Sprintf(
// 			c.endpoint.String()+"/api/v1/assets/assets/?offset=%d&limit=%d&display=1&draw=1",
// 			offset, limit,
// 		)
// 		r, err := c.Get(u)
// 		if err != nil {
// 			return nil, err
// 		}

// 	}

// 	return assets, nil
// }

func (c *Client) ListSystemUsers(assetID string) ([]SystemUser, error) {
	u := fmt.Sprintf(c.endpoint.String()+"/api/v1/perms/users/assets/%s/system-users/", assetID)
	r, err := c.Get(u)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	content, err := ioutil.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}

	var result []SystemUser
	if err := json.Unmarshal(content, &result); err != nil {
		return nil, err
	}
	return result, nil
}

type Message struct {
	Id   string `json:"id"`
	Type string `json:"type"`
	Data string `json:"data"`
}

const (
	PING           = "PING"
	PONG           = "PONG"
	CONNECT        = "CONNECT"
	CLOSE          = "CLOSE"
	TERMINALINIT   = "TERMINAL_INIT"
	TERMINALDATA   = "TERMINAL_DATA"
	TERMINALRESIZE = "TERMINAL_RESIZE"
)

type WindowSize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

// ConnectAsset connects to asset, opens a ternamal
func (c *Client) ConnectAsset(targetID string, systemUserID string) error {
	dailer := &websocket.Dialer{Jar: c.Jar}
	scheme := "ws"
	if c.endpoint.Scheme == "https" {
		scheme = "wss"
	}
	u := fmt.Sprintf(
		"%s://%s/koko/ws/terminal/?target_id=%s&type=asset&system_user_id=%s",
		scheme, c.endpoint.Host, targetID, systemUserID,
	)
	ws, _, err := dailer.Dial(u, nil)
	if err != nil {
		return fmt.Errorf("failed to connect: %s", err)
	}
	defer fmt.Fprintln(os.Stderr, "Connection closed")
	defer ws.Close()

	return c.enterTty(targetID, ws)
}

func (c *Client) enterTty(targetID string, ws *websocket.Conn) error {
	var firstMsg Message
	if err := ws.ReadJSON(&firstMsg); err != nil {
		return err
	}

	if firstMsg.Type != CONNECT {
		return fmt.Errorf("Expected got CONNECT message, but got %s", firstMsg.Type)
	}
	cid := firstMsg.Id

	t, err := tty.Open()
	if err != nil {
		return err
	}
	defer t.Close()

	clean, err := t.Raw()
	if err != nil {
		return err
	}
	defer clean()

	w, h, err := t.Size()
	if err != nil {
		return err
	}

	if err := ws.WriteJSON(&Message{
		Id:   cid,
		Type: TERMINALINIT,
		Data: fmt.Sprintf(`{"cols":%d,"rows":%d}`, w, h),
	}); err != nil {
		return err
	}

	ttyInput := make(chan struct {
		data []byte
		err  error
	})

	go func() {
		for {
			data := make([]byte, 8*1024)
			n, err := t.Input().Read(data)
			ttyInput <- struct {
				data []byte
				err  error
			}{data: data[:n], err: err}
			if err != nil {
				return
			}
		}
	}()

	wsInput := make(chan struct {
		msg *Message
		err error
	})

	go func() {
		for {
			msg := Message{}
			err := ws.ReadJSON(&msg)
			wsInput <- struct {
				msg *Message
				err error
			}{msg: &msg, err: err}
			if err != nil {
				return
			}
		}
	}()

	sigwatch := t.SIGWINCH()

	lastOutput := ""

	for {
		select {
		case s := <-sigwatch:
			if err := ws.WriteJSON(&Message{
				Id:   cid,
				Type: TERMINALRESIZE,
				Data: fmt.Sprintf(`{"cols":%d,"rows":%d}`, s.W, s.H),
			}); err != nil {
				return err
			}
		case ti := <-ttyInput:
			if ti.err != nil {
				return ti.err
			}
			if err := ws.WriteJSON(&Message{
				Id:   cid,
				Type: TERMINALDATA,
				Data: string(ti.data),
			}); err != nil {
				return err
			}
		case wi := <-wsInput:
			if wi.err != nil {
				return wi.err
			}
			switch wi.msg.Type {
			case TERMINALDATA:
				if _, err := t.Output().Write([]byte(wi.msg.Data)); err != nil {
					return err
				}
				lastOutput = wi.msg.Data
			case CLOSE:
				if lastOutput[len(lastOutput)-1] != '\n' {
					t.Output().WriteString("\r\n")
				}
				return nil
			case PING:
				if err := ws.WriteJSON(&wi.msg); err != nil {
					return wi.err
				}
			}
		}
	}
}
