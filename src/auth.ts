import os from 'os'
import fs from 'fs'
import path from 'path'
import { client as http } from './http'
import { URLSearchParams } from 'url'
import inquirer from 'inquirer'
import { CookieJar } from 'tough-cookie'

export async function login(endpoint: string, username: string, password: string) {
  const form = new URLSearchParams()
  form.append('username', username)
  form.append('password', password)

  const resp = await http.get(`${endpoint}/users/login/`)

  const m1 = /<img src="(.*)" alt="captcha" class="captcha"/.exec(resp.data)
  if (m1) {
    const m = /name="captcha_0" type="hidden" value="(\w+)"/.exec(resp.data)
    if (!m) {
      console.error('Connot find captcha info')
      process.exit(1)
    } else {
      const captchaId = m[1]
      form.append('captcha_0', captchaId)
    }
    const url = m1[1]
    const resp2 = await http.get(`${endpoint}${url}`, { responseType: 'arraybuffer' })
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmsh'))
    const filePath = `${tmpDir}/1.png`
    fs.writeFileSync(filePath, resp2.data)

    console.log(`Captcha founded, please interpret it: file://${filePath}`)
    if (process.env.TERM_PROGRAM = 'iTerm.app') {
      imgCat(filePath)
    }
    const { captcha } = await inquirer.prompt({
      name: 'captcha'
    })
    form.append('captcha_1', captcha)

    fs.unlinkSync(filePath)
    fs.rmdirSync(tmpDir)
  }

  form.append('csrfmiddlewaretoken', cookieGetValue(http.cookies, endpoint, 'csrftoken'))

  const loginResp = await http.post(`${endpoint}/users/login/`, form, { maxRedirects: 0 })
  if (loginResp.status !== 302) {
    console.error('Failed to login: please check you username and password')
    process.exit(1)
  }

  if (loginResp.headers.location === '/users/login/otp/') {
    const form2 = new URLSearchParams()

    await http.get(`${endpoint}/users/login/otp/`)
    form2.append('csrfmiddlewaretoken', cookieGetValue(http.cookies, endpoint, 'csrftoken'))

    const { otpCode } = await inquirer.prompt({
      name: 'otpCode',
      message: '2FA Code:'
    })
    form2.append('otp_code', otpCode)

    const resp3 = await http.post(`${endpoint}/users/login/otp/`, form2, { maxRedirects: 0 })
    if (resp3.status !== 302) {
      console.error('Failed to login: please check you 2FA Code is correct')
      process.exit(1)
    }
  }

  return {
    sessionId: cookieGetValue(http.cookies, endpoint, 'sessionid'),
    csrfToken: cookieGetValue(http.cookies, endpoint, 'csrftoken')
  }
}

function cookieGetValue(jar: CookieJar, currentUrl: string, name: string) {
  const cookie = jar.getCookiesSync(currentUrl).filter(c => c.key === name)[0]
  if (cookie) {
    return cookie.value
  } else {
    throw new Error(`${name} not found`)
  }
}

function imgCat(path: string) {
  const inScreen = /^screen.*$/.exec(process.env.TERM || '') !== null
  const OSC = inScreen ? '\x1bPtmux;\x1b\x1b]' : '\x1b]'
  const ST = inScreen ? '\x07\x1b\\' : '\x07'
  const content = fs.readFileSync(path).toString('base64')
  console.log(`${OSC}1337;File=name=1.png;height=2;inline=1:${content}${ST}`)
}
