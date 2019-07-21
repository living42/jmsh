import { Socket } from 'net'

export class Transport {
  sock: Socket
  readWaiters: Queue

  readBuf: Buffer

  buffer: any[]

  constructor(sock: Socket) {
    this.sock = sock
    this.readWaiters = new Queue()
    this.readBuf = Buffer.alloc(0)
    this.buffer = []

    sock.on('error', async e => {
      while (this.readWaiters.length > 0) {
        const [_, reject] = await this.readWaiters.pop()
        reject(e)
      }
    })
    sock.on('end', async () => {
      while (this.readWaiters.length > 0) {
        const [_, reject] = await this.readWaiters.pop()
        reject(new TransportEndError())
      }
    })

    sock.on('data', async payload => {
      this.readBuf = Buffer.concat([this.readBuf, payload])

      while (this.readBuf.byteLength >= 4) {
        const frameLength = this.readBuf.readUInt32BE(0)
        const frame = this.readBuf.slice(4, frameLength + 4)

        if (frame.byteLength == frameLength) {
          this.readBuf = this.readBuf.slice(frameLength + 4)
          let data
          try {
            data = JSON.parse(frame.toString())
          } catch (e) {
            console.debug('payload', payload.toString())
            console.debug('readBuf:', this.readBuf.toString())
            console.debug("frameLength:", frameLength)
            console.debug('data:', frame.toString())
            console.debug('dataLength:', frame.byteLength)
            throw e
          }
          this.buffer.push(data)
          const [resolve, _] = await this.readWaiters.pop()
          if (resolve) {
            resolve()
          }
        } else {
          break
        }
      }
    })
  }

  async postMessage(message: any) {
    const payload = JSON.stringify({ ...message })
    const body = Buffer.from(payload)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.byteLength, 0)
    this.sock.write(Buffer.concat([header, body]))
  }

  async readMessage(): Promise<any> {
    while (true) {
      if (this.buffer.length > 0) {
        return this.buffer.shift()
      }
      await new Promise((resolve, reject) => {
        this.readWaiters.put([resolve, reject])
      })
    }
  }

  close() {
    this.sock.end()
  }
}

export class TransportEndError extends Error { }

class Queue {
  _waiters: (() => void)[]
  _items: any[]
  constructor() {
    this._waiters = []
    this._items = []
  }

  get length() {
    return this._items.length
  }

  async put(item: any) {
    this._items.push(item)
    if (this._waiters.length > 0) {
      const f = this._waiters.shift()
      if (f) {
        f()
      }
    }
  }
  async pop() {
    if (this._items.length === 0) {
      await new Promise(resolve => {
        this._waiters.push(resolve)
      })
    }
    return this._items.shift()
  }
}
