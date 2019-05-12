import { Transport, TransportEndError } from './transport'
import net from 'net'

export interface Handler {
  name: string
  handle(req: any, tranpsort: Transport): Promise<void>
}

export interface Config {
  name: string
}

export interface Client {
  openTransport(): Promise<Transport>
}

interface Endpoint {
  name: string
}

export class CallEndpoint<REQ, REP> implements Endpoint {
  readonly name: string

  constructor(config: Config) {
    this.name = config.name
  }

  async call(req: REQ, client: Client): Promise<REP> {
    const transport = await client.openTransport()
    transport.postMessage({ method: this.name, req: req })
    const msg = await transport.readMessage()
    transport.close()
    if (msg.error) {
      throw msg.error
    }
    return msg.rep
  }

  handler(handleFunc: (req: REQ) => Promise<REP>): Handler {
    return {
      name: this.name,
      async handle(req: REQ, transport) {
        try {
          const rep = await handleFunc(req)
          transport.postMessage({ rep })
        } catch (error) {
          console.log('handler got error', error)
          transport.postMessage({ error: error instanceof Error ? error.message : error })
        } finally {
          transport.close()
        }
      }
    }
  }
}

export class Channel<INPUT, OUTPUT> {
  transport: Transport
  handlers: { [key: string]: (() => void)[] }

  constructor(transport: Transport) {
    this.transport = transport
    this.handlers = {}
    this.loop()
  }

  on(event: 'message', handler: (input: OUTPUT) => void): void
  on(event: 'error', handler: (e: Error) => void): void
  on(event: 'end', handler: () => void): void
  on(event: any, handler: any) {
    if (this.handlers[event] === undefined) {
      this.handlers[event] = []
    }
    this.handlers[event].push(handler)
  }

  send(message: INPUT): void {
    this.transport.postMessage(message)
  }

  close() {
    this.transport.close()
  }

  private async loop() {
    while (true) {
      try {
        const msg = await this.transport.readMessage()
        ;(this.handlers['message'] || []).forEach(handler => {
          ;(handler as (msg: OUTPUT) => void)(msg)
        })
      } catch (e) {
        if (e instanceof TransportEndError) {
          ;(this.handlers['end'] || []).forEach(handler => {
            ;(handler as () => void)()
          })
          return
        }
        ;(this.handlers['error'] || []).forEach(handler => {
          ;(handler as (e: Error) => void)(e)
        })
        return
      }
    }
  }
}

interface ChannelHandler<INPUT, OUTPUT> {
  (channel: Channel<INPUT, OUTPUT>): Promise<void>
}

export class ChannelEndpoint<REQ, INPUT, OUTPUT> implements Endpoint {
  readonly name: string

  constructor(config: Config) {
    this.name = config.name
  }

  async call(req: REQ, client: Client): Promise<Channel<INPUT, OUTPUT>> {
    const transport = await client.openTransport()
    transport.postMessage({ method: this.name, req: req })
    const msg = await transport.readMessage()
    if (msg.error) {
      transport.close()
      throw msg.error
    }
    return new Channel<INPUT, OUTPUT>(transport)
  }

  handler(handleFunc: (req: REQ) => Promise<ChannelHandler<OUTPUT, INPUT>>): Handler {
    return {
      name: this.name,
      async handle(req: REQ, transport) {
        try {
          const channelHandler = await handleFunc(req)
          transport.postMessage({})
          await channelHandler(new Channel<OUTPUT, INPUT>(transport))
        } catch (error) {
          transport.postMessage({ error })
        } finally {
          transport.close()
        }
      }
    }
  }
}

export class Server {
  private _handlers: { [key: string]: Handler }

  constructor() {
    this._handlers = {}
  }

  addEndpoint(handler: Handler) {
    if (this._handlers[handler.name] !== undefined) {
      throw new Error('endpoint already registered')
    }
    this._handlers[handler.name] = handler
  }

  handlers(...handlers: Handler[]) {
    for (const handler of handlers) {
      this.addEndpoint(handler)
    }
  }

  async serve(sockServer: net.Server) {
    return new Promise((resolve, reject) => {
      sockServer.on('error', reject)
      sockServer.on('close', resolve)
      sockServer.on('connection', async sock => {
        const transport = new Transport(sock)
        const msg = await transport.readMessage()
        const method = msg.method
        if (!method) {
          console.warn('unknown msg', msg)
          transport.close()
          return
        }

        const handler = this._handlers[method]
        if (!handler) {
          console.warn('endpoint not found for this msg', msg)
          transport.close()
        }
        try {
          await handler.handle(msg.req, transport)
        } catch (e) {
          console.error('handler error', e)
        } finally {
          transport.close()
        }
      })
    })
  }
}
