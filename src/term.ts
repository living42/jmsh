import os from 'os'
import fs from 'fs'
import path from 'path'
import UUID from 'uuid-js'
import inquirer from 'inquirer'
import { URLSearchParams } from 'url'
import { client as http } from './http'
import { CookieJar } from 'tough-cookie'
import io from 'socket.io-client'

export default class Term {
    protected url: string
    protected csrftoken?: string
    protected sessionId?: string
    protected socket?: SocketIOClient.Socket

    constructor(url: string) {
        this.url = url
    }

    public async login() {
        const answers = await inquirer.prompt<{ username: string; password: string }>([
            { name: 'username' },
            { name: 'password', type: 'password' }
        ])

        const { username, password } = answers

        if (!username || !password) {
            console.error('Please enter username and password to login')
            process.exit(1)
        }

        const form = new URLSearchParams()
        form.append('username', username)
        form.append('password', password)

        const resp = await http.get(`${this.url}/users/login/`)

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
            const resp2 = await http.get(`${this.url}${url}`, { responseType: 'stream' })
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jms-connect'))
            const filePath = `${tmpDir}/1.png`
            resp2.data.pipe(fs.createWriteStream(filePath))

            console.log(`Captcha founded, please interpret it: file://${filePath}`)
            const { captcha } = await inquirer.prompt<{ captcha: string }>({
                name: 'captcha'
            })
            form.append('captcha_1', captcha)

            fs.unlinkSync(filePath)
            fs.rmdirSync(tmpDir)
        }

        const m2 = /<input type="hidden" name="csrfmiddlewaretoken" value="(\w+)">/.exec(resp.data)
        if (!m2) {
            console.error('Cannot find csrfmiddlewaretoken.')
            process.exit(1)
            return
        }

        const csrfToken = cookieGetValue(http.cookies, this.url, 'csrftoken')

        this.csrftoken = csrfToken
        form.append('csrfmiddlewaretoken', csrfToken)

        const loginResp = await http.post(`${this.url}/users/login/`, form, { maxRedirects: 0 })
        if (loginResp.status !== 302) {
            console.error('Failed to login: please check you username and password')
            process.exit(1)
        }

        if (loginResp.headers.location === '/users/login/otp/') {
            const form2 = new URLSearchParams()

            const resp4 = await http.get(`${this.url}/users/login/otp/`)
            const m3 = /<input type="hidden" name="csrfmiddlewaretoken" value="(\w+)">/.exec(resp4.data)
            if (!m3) {
                console.error('Cannot find csrfmiddlewaretoken.')
                process.exit(1)
                return
            }
            this.csrftoken = cookieGetValue(http.cookies, this.url, 'csrftoken')
            form.append('csrfmiddlewaretoken', this.csrftoken)

            const { otpCode } = await inquirer.prompt<{ otpCode: string }>({
                name: 'otpCode',
                message: '2FA Code:'
            })
            form2.append('csrfmiddlewaretoken', csrfToken)
            form2.append('otp_code', otpCode)

            const resp3 = await http.post(`${this.url}/users/login/otp/`, form2, { maxRedirects: 0 })
            if (resp3.status !== 302) {
                console.error('Failed to login: please check you 2FA Code is correct')
                process.exit(1)
            }
        }

        const sessionId = cookieGetValue(http.cookies, this.url, 'sessionid')

        this.sessionId = sessionId
    }

    public async establishConnection() {
        const socket = io.connect(`${this.url}/ssh`, {
            transportOptions: {
                polling: {
                    extraHeaders: {
                        cookie: `csrftoken=${this.getCsrfToken()}; sessionid=${this.getSessionId()}`
                    }
                }
            }
        })
        await new Promise(resolve => {
            socket.on('connect', resolve)
        })
        this.socket = socket
    }

    public async connect(asset: ITreeNode) {
        // NOTE inquirer altered stdin we should resume it
        process.stdin.resume()

        const secret = UUID.create().toString()

        const socket = this.getSocket()

        socket.emit('host', {
            uuid: asset.id,
            userid: asset.meta.system_users[0].id,
            secret: secret,
            size: [process.stdout.columns, process.stdout.rows]
        })

        socket.on('data', (data: any) => {
            process.stdout.write(data.data)
        })

        const setRawMode = (mode: boolean) => {
            if (!process.stdin.setRawMode) {
                throw new Error('Please run this program in terminal')
            }
            process.stdin.setRawMode(mode)
        }

        let room: string
        socket.on('room', (data: any) => {
            if (data.secret === secret) {
                room = data.room
                socket.off('room')
                setRawMode(true)
            }
        })

        process.stdin.on('data', chunk => {
            socket.emit('data', { data: chunk.toString(), room: room })
        })

        process.stdout.on('resize', () => {
            socket.emit('resize', {
                cols: process.stdout.columns,
                rows: process.stdout.rows
            })
        })

        socket.on('logout', (data: any) => {
            if (data.room === room) {
                setRawMode(false)
                process.exit(0)
            }
        })
    }

    public async getAssets() {
        const resp2 = await http.get(`${this.url}/api/perms/v1/user/nodes-assets/tree/`)
        return resp2.data as ITreeNode[]
    }

    protected getCsrfToken(): string {
        if (!this.csrftoken) {
            throw new Error('csrftoken is undefined')
        }
        return this.csrftoken
    }

    protected getSessionId(): string {
        if (!this.sessionId) {
            throw new Error('sessionId is undefined')
        }
        return this.sessionId
    }

    protected getSocket(): SocketIOClient.Socket {
        if (!this.socket) {
            throw new Error('socket is undefined')
        }
        return this.socket
    }
}

export interface ITreeNode {
    id: string
    meta: ITreeNodeMeta
    name: string
}

interface ITreeNodeMeta {
    type: 'node' | 'asset'
    system_users: IAssetSystemUser[]
}

interface IAssetSystemUser {
    id: string
}

function cookieGetValue(jar: CookieJar, currentUrl: string, name: string): string {
    const cookie = jar.getCookiesSync(currentUrl).filter(c => c.key === name)[0]
    if (cookie) {
        return cookie.value
    } else {
        throw new Error(`${name} not found`)
    }
}
