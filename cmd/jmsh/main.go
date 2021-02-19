package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/url"
	"os"
	"os/exec"
	"path"
	"runtime"
	"strconv"
	"strings"

	"github.com/living42/jmsh"
	"github.com/manifoldco/promptui"
)

func main() {
	// TODO save cookies (XDG_CACHE_HOME, $HOME/.cache)
	// TODO search assets
	// TODO code organize

	user := ""
	hostname := ""
	if len(os.Args) == 2 {
		arg := os.Args[1]
		if idx := strings.Index(arg, "@"); idx > 0 {
			user, hostname = arg[:idx], arg[idx+1:]
		} else {
			hostname = arg
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}

	xdgHome, ok := os.LookupEnv("XDG_CONFIG_HOME")
	if !ok {
		xdgHome = path.Join(home, ".config")
	}
	configPath := path.Join(xdgHome, "jmsh", "config.json")

	config, err := loadConfig(configPath)

	// xdgCache, ok := os.LookupEnv("XDG_CACHE_HOME")
	// if !ok {
	// 	xdgCache = path.Join(home, ".cache")
	// }
	// cookieJarPath := path.Join(xdgCache, "jmsh", "cookies.json")

	shouldSaveConfig := false
	shouldSavePassword := false
	password := ""

	if config.Endpoint == "" {
		config.Endpoint, err = (&promptui.Prompt{
			Label:    "Endpoint",
			Validate: validateEndpoint,
		}).Run()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		config.Username, err = (&promptui.Prompt{
			Label: "Username",
		}).Run()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		shouldSaveConfig = true
	}

	c, err := jmsh.NewClient(config.Endpoint)
	if err != nil {
		fmt.Println(err)
	}

	if true {
		if config.SavePassword != nil && *config.SavePassword {
			password, err = findPasswordInKeyChain(config.Endpoint, config.Username)
			if err != nil {
				fmt.Println(err)
			}
		}
		if password == "" {
			password, err = (&promptui.Prompt{
				Label: "Password",
				Mask:  '*',
			}).Run()
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		lp, err := c.FetchLoginPage()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		captcha := ""
		if lp.HasCaptcha() {
			cImg, err := lp.FetchCaptcha()
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}

			captcha, err = resolveCaptcha(cImg)
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
		}

		lr, err := lp.Submit(config.Username, password, captcha)
		if err != nil {
			if lr.HasOTP() {
				otp, err := (&promptui.Prompt{
					Label: "OTP",
				}).Run()
				if err != nil {
					fmt.Println(err)
					os.Exit(1)
				}
				if _, err = lr.SubmitOTP(otp); err != nil {
					fmt.Println(err)
					os.Exit(1)
				}
			} else {
				fmt.Println(err)
				os.Exit(1)
			}
		}
		fmt.Println("login success")

		if config.SavePassword == nil && runtime.GOOS == "darwin" {
			result, _ := (&promptui.Prompt{
				Label:     "Save password",
				IsConfirm: true,
			}).Run()
			if strings.ToUpper(result) == "Y" {
				y := true
				config.SavePassword = &y
				shouldSaveConfig = true
				shouldSavePassword = true
			}
		} else if *config.SavePassword {
			shouldSavePassword = true
		}
	}

	if shouldSaveConfig {
		fmt.Println("saving config")
		if err := saveConfig(configPath, config); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

	}
	if shouldSavePassword {
		if err := addPasswordToKeyChain(config.Endpoint, config.Username, password); err != nil {
			fmt.Println(err)
		}
	}

	if hostname == "" {
		hostname, err = (&promptui.Prompt{
			Label: "Hostname",
		}).Run()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
	}

	asset, ok, err := c.FindAssetByHostname(hostname)
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	if !ok {
		fmt.Println("no asset found")
		os.Exit(1)
	}
	sysUsers, err := c.ListSystemUsers(asset.ID)
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	if len(sysUsers) == 0 {
		fmt.Println("no system user found")
		os.Exit(1)
	}
	var userOpts []string
	var sysUser *jmsh.SystemUser
	for _, u := range sysUsers {
		userOpts = append(userOpts, u.Username)
	}
	if user == "" {
		if len(sysUsers) > 1 {
			i, _, err := (&promptui.Select{
				Label: "Select System User",
				Items: userOpts,
			}).Run()
			if err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
			sysUser = &sysUsers[i]
		} else {
			sysUser = &sysUsers[0]
		}
	} else {
		for _, u := range sysUsers {
			if u.Username == user {
				sysUser = &u
				break
			}
		}
		if sysUser == nil {
			fmt.Printf("no system user found (available option are: %s)\n", strings.Join(userOpts, ", "))
			os.Exit(1)
		}
	}

	fmt.Printf("connecting %s@%s\n", sysUser.Username, asset.Hostname)

	if err := c.ConnectAsset(asset.ID, sysUser.ID); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}

func validateEndpoint(input string) error {
	if !strings.HasPrefix(input, "http://") && !strings.HasPrefix(input, "https://") {
		return fmt.Errorf("must be a http url")
	}
	u, err := url.Parse(input)
	if err != nil {
		return err
	}
	if u.Path != "" {
		return fmt.Errorf("must not contain path")
	}
	return nil
}

type Config struct {
	Endpoint     string `json:"endpoint"`
	Username     string `json:"username"`
	SavePassword *bool  `json:"savePassword,omitempty"`
}

func loadConfig(p string) (Config, error) {
	var config Config
	content, err := ioutil.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return config, nil
		}
		return config, err
	}
	err = json.Unmarshal(content, &config)
	return config, err
}

func saveConfig(p string, config Config) error {
	renamed := false
	t, err := ioutil.TempFile(path.Dir(p), "config_*.json")
	if err != nil {
		return err
	}
	defer func() {
		t.Close()
		if !renamed {
			os.Remove(t.Name())
		}
	}()

	content, err := json.MarshalIndent(&config, "", "  ")
	if err != nil {
		return err
	}
	if _, err := t.Write(content); err != nil {
		return err
	}

	return os.Rename(t.Name(), p)
}

func resolveCaptcha(img []byte) (string, error) {
	if tp, _ := os.LookupEnv("TERM_PROGRAM"); tp == "iTerm.app" {
		fmt.Printf("Captcha founded, please interpret it:")
		itermImgCat(img)
	} else {
		t, err := ioutil.TempFile("", "jmsh_captcha_*.png")
		if err != nil {
			return "", err
		}
		defer os.Remove(t.Name())
		defer t.Close()

		if _, err := t.Write(img); err != nil {
			return "", err
		}
		if err := t.Sync(); err != nil {
			return "", err
		}

		fmt.Printf("Captcha founded, please interpret it: file://%s\n", t.Name())
		fmt.Println("Open another Terminal or press Ctrl-Z to inspect image")
	}

	return (&promptui.Prompt{
		Label: "Captcha",
	}).Run()
}

func itermImgCat(img []byte) {
	osc := "\x1b]"
	st := "\x07"

	if termEnv, _ := os.LookupEnv("TERM"); strings.HasPrefix(termEnv, "screen") {
		osc = "\x1bPtmux;\x1b\x1b]"
		st = "\x07\x1b\\"
	}

	content := base64.StdEncoding.EncodeToString(img)

	fmt.Println()
	fmt.Print(osc + "1337;File=name=captcha.png;size=" + strconv.Itoa(len(img)) + ";height=4;width=auto;inline=1:" + content + st)
}

func addPasswordToKeyChain(endpoint, username, password string) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	host := u.Host

	cmd := exec.Command(
		"security", "add-generic-password",
		"-a", fmt.Sprintf("%s@%s", username, host),
		"-c", "jmsh",
		"-C", "jmsh",
		"-D", "Jumpserver account for jmsh",
		"-s", "jmsh account",
		"-w", password,
		"-U")
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func findPasswordInKeyChain(endpoint, username string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	host := u.Host

	cmd := exec.Command(
		"security", "find-generic-password",
		"-a", fmt.Sprintf("%s@%s", username, host),
		"-c", "jmsh",
		"-s", "jmsh account",
		"-gw")
	cmd.Stderr = os.Stderr
	output, err := cmd.Output()
	if err != nil {
		if cmd.ProcessState.ExitCode() == 44 {
			return "", nil
		}
		return "", err
	}

	return strings.TrimSpace(string(output)), nil
}

// async function findPasswordInKeyChain(config: Config): Promise<string | null> {
// 	const host = new URL(config.endpoint).host
// 	const r = child_process.spawnSync("security", ["find-generic-password", "-a", `${config.username}@${host}`, "-c", "jmsh", "-s", 'jmsh account', "-gw"])
// 	if (r.status.toString() === '0') {
// 	  return r.stdout.toString().trim()
// 	}
// 	if (r.status.toString() === '44') {
// 	  return null
// 	}
// 	throw new Error(r.stderr.toString())
//   }

//   async function addPasswordToKeyChain(config: Config, password: string) {
// 	const host = new URL(config.endpoint).host
// 	const r = child_process.spawnSync("security", ["add-generic-password", "-a", `${config.username}@${host}`, "-c", "jmsh", "-C", "jmsh", "-D", 'Jumpserver account for jmsh', "-s", 'jmsh account', "-w", password, "-U"])
// 	if (r.status.toString() === '0') {
// 	  return
// 	}
// 	throw new Error(r.stderr.toString())
//   }
