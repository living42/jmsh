package jmsh

import (
	"testing"
)

const (
	endpoint = "http://127.0.0.1:8080"
	username = "admin"
	password = "zeqing"
	otp      = "812028"
)

func login(t *testing.T) *Client {
	c, err := NewClient(endpoint)
	if err != nil {
		t.Fatal(err)
	}

	loginPage, err := c.FetchLoginPage()
	if err != nil {
		t.Fatal(err)
	}

	var captcha string
	if loginPage.HasCaptcha() {
		t.Fatal("encounter captcha!")
	}

	lr, err := loginPage.Submit(username, password, captcha)
	if err != nil {
		t.Fatal(err)
	}
	if lr.HasOTP() {
		if lr, err = lr.SubmitOTP(otp); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func TestLogin(t *testing.T) {
	c := login(t)

	for _, cookie := range c.Client.Jar.Cookies(c.endpoint) {
		println(cookie.String())
	}
}

func TestFindAssetByHostname(t *testing.T) {
	c := login(t)

	asset, ok, err := c.FindAssetByHostname("node1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("no found asset")
	}
	t.Logf("asset: %#v", asset)
}

func TestListSystemUsers(t *testing.T) {
	c := login(t)

	asset, ok, err := c.FindAssetByHostname("node1")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("no found asset")
	}
	t.Logf("asset: %#v", asset)

	users, err := c.ListSystemUsers(asset.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("system_user of %s: %#v", asset.ID, users)

	if len(users) == 0 {
		t.Fatal("no system user found")
	}
}
