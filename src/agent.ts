import net from 'net'
import * as rpc from './rpc'
import * as endpoints from './endpoints'
import exitHook from 'exit-hook'
import { Transport } from './transport'
import UUID from 'uuid-js'
import io from 'socket.io-client'
import { client as http } from './http'
import { AxiosError } from 'axios'

export async function startAgent() {
  const sockPath = process.env.JMSH_AGENT_SOCK_PATH

  const server = new rpc.Server()

  const connections: { [key: string]: Connection } = {}

  const connKey = (req: { endpoint: string; username: string }) => `${req.endpoint}@${req.username}`

  server.handlers(
    endpoints.checkConnection.handler(async req => {
      return connections[connKey(req)] !== undefined
    }),
    endpoints.createConnection.handler(async req => {
      console.log('create connection', { endpoint: req.endpoint, username: req.username })
      const socket = io.connect(`${req.endpoint}/ssh`, {
        transportOptions: {
          polling: {
            extraHeaders: {
              cookie: `csrftoken=${req.csrfToken}; sessionid=${req.sessionId}`
            }
          }
        }
      })
      await new Promise((resolve, reject) => {
        socket.on('connect', resolve)
        socket.on('connect_error', reject)
      })
      socket.off('connect')
      socket.off('connect_error')

      socket.on('reconnect_error', (error: Error) => {
        console.log(`[${connKey(req)}] reconnect error`, error)
        socket.close()
        console.log('close connection', { endpoint: req.endpoint, username: req.username })
        delete connections[connKey(req)]
      })

      connections[connKey(req)] = { ...req, socket, mux: new Mux(socket), assets: [] }
    }),
    endpoints.connectAsset.handler(async req => {
      const c = connections[connKey(req)]
      if (!c) {
        throw Error('no connection avaliable')
      }

      const roomId = await c.mux.createRoom(req.uuid, req.userid, req.cols, req.rows)

      console.log('create room', { roomId })

      return async channel => {
        await new Promise((resolve, reject) => {
          c.mux.on(roomId, 'data', data => channel.send({ data }))
          c.mux.on(roomId, 'logout', resolve)
          c.mux.on(roomId, 'error', reject)

          channel.on('message', msg => {
            const event = msg.event
            delete msg.event
            c.socket.emit(event, { room: roomId, ...msg })
          })
          channel.on('end', () => {
            console.log('logout', { roomId })
            c.socket.emit('logout', { room: roomId })
          })
          channel.on('error', e => {
            console.log('logout', { roomId, e })
            c.socket.emit('logout', { room: roomId })
            reject(e)
          })
        }).finally(() => {
          c.mux.off(roomId, 'data')
          c.mux.off(roomId, 'logout')
          c.mux.off(roomId, 'error')
        })
      }
    }),
    endpoints.getAssets.handler(async req => {
      const c = connections[connKey(req)]
      if (!c) {
        throw Error('no connection avaliable')
      }

      if (req.fromCache && Object.keys(c.assets).length > 0) {
        return c.assets
      }

      let resp
      try {
        resp = await http.get<Array<any>>(`${c.endpoint}/api/perms/v1/user/nodes-assets/`, {
          headers: {
            'Accept-Encoding': 'gzip',
            Accept: 'application/json',
            Cookie: `sessionid=${c.sessionId}`
          }
        })
      } catch (e) {
        const response = (e as AxiosError).response
        if (response && response.status == 403) {
          // abandon connection
          delete connections[connKey(req)]
          throw new Error('unauthenticated')
        }
        throw e
      }

      const assets: Asset[] = []

      for (const group of resp.data) {
        for (const asset of group['assets_granted']) {
          if (asset.protocol !== 'ssh') {
            continue
          }

          assets.push({ group: group.name, ...asset })
        }
      }

      c.assets = assets
      return c.assets
    })
  )

  console.log('start agent')
  console.log(`listen on ${sockPath}`)
  const l = net.createServer().listen(sockPath)
  await new Promise((resolve, reject) => {
    l.on('listening', resolve)
    l.on('error', reject)
  })
  exitHook(() => {
    l.close()
  })
  await server.serve(l)
}

export class Client implements rpc.Client {
  sockPath: string

  constructor(sockPath: string) {
    this.sockPath = sockPath
  }

  async openTransport(): Promise<Transport> {
    const sock = net.createConnection(this.sockPath)
    await new Promise((resolve, reject) => {
      sock.on('connect', resolve)
      sock.on('error', reject)
    }).then(() => {
      sock.removeAllListeners('error')
      sock.removeAllListeners('connect')
    })
    return new Transport(sock)
  }
}

interface Connection {
  endpoint: string
  username: string
  sessionId: string
  socket: SocketIOClient.Socket
  mux: Mux
  assets: Asset[]
}

class Mux {
  socket: SocketIOClient.Socket
  private handlers: { [key: string]: (() => void)[] }

  constructor(socket: SocketIOClient.Socket) {
    this.socket = socket
    this.handlers = {}

    socket.on('data', (data: any) => this.handleEvent('data', data))
    socket.on('room', (data: any) => this.handleEvent('room', data))
    socket.on('logout', (data: any) => this.handleEvent('logout', data))
    socket.on('reconnect_error', (e: Error) => {
      for (const key in this.handlers) {
        if (key.endsWith('/error')) {
          this.handlers[key].forEach(handler => {
            ;(handler as (e: Error) => void)(e)
          })
        }
      }
    })
  }

  private handleEvent(event: string, data: any) {
    let roomId: string
    switch (event) {
      case 'data':
      case 'logout':
        roomId = data.room
        ;(this.handlers[`${roomId}/${event}`] || []).forEach(handler => {
          ;(handler as (data: string) => void)(data.data)
        })
        break
      case 'room':
        const secret = data.secret
        roomId = data.room
        ;(this.handlers[`${secret}/${event}`] || []).forEach(handler => {
          ;(handler as (roomId: string) => void)(roomId)
        })
        break
    }
  }

  async createRoom(uuid: string, userid: string, cols: number, rows: number): Promise<string> {
    const secret = UUID.create().toString()

    this.socket.emit('host', {
      uuid: uuid,
      userid: userid,
      secret: secret,
      size: [cols, rows]
    })

    const roomId = await new Promise((resolve, reject) => {
      this.handlers[`${secret}/room`] = [resolve]
    })
    delete this.handlers[`${secret}/room`]
    return roomId as string
  }

  on(roomId: string, event: 'data', handler: (data: string) => void): void
  on(roomId: string, event: 'logout', handler: () => void): void
  on(roomId: string, event: 'error', handler: (e: Error) => void): void
  on(roomId: string, event: 'data' | 'logout' | 'error', handler: any) {
    if (this.handlers[`${roomId}/${event}`] == undefined) {
      this.handlers[`${roomId}/${event}`] = []
    }
    this.handlers[`${roomId}/${event}`].push(handler)
  }

  off(roomId: string, event: 'data' | 'logout' | 'error') {
    delete this.handlers[`${roomId}/${event}`]
  }
}

export interface Asset {
  group: string
  id: string
  hostname: string
  system_users_granted: SystemUser[]
}

export interface SystemUser {
  id: string
  name: string
}
