import { Socket } from 'net'

export class Transport {
  sock: Socket
  readingQueue: Queue

  readBuf: Buffer

  constructor(sock: Socket) {
    this.sock = sock
    this.readingQueue = new Queue()
    this.readBuf = Buffer.alloc(0)

    sock.on('error', async e => {
      while (this.readingQueue.length > 0) {
        const [_, reject] = await this.readingQueue.pop()
        reject(e)
      }
    })
    sock.on('end', async () => {
      while (this.readingQueue.length > 0) {
        const [_, reject] = await this.readingQueue.pop()
        reject(new TransportEndError())
      }
    })

    sock.on('data', async payload => {
      this.readBuf = Buffer.concat([this.readBuf, payload])

      const frameLength = this.readBuf.readUInt32BE(0)
      if (this.readBuf.byteLength + 4 >= frameLength) {
        const frame = this.readBuf.slice(4, frameLength + 4)
        this.readBuf = this.readBuf.slice(frameLength + 4)
        const data = JSON.parse(frame.toString())
        const [resolve, _] = await this.readingQueue.pop()
        delete data.pad
        resolve(data)
      }
    })
  }

  async postMessage(message: any) {
    const payload = JSON.stringify({ pad: '1'.repeat(10000), ...message })
    const body = Buffer.from(payload)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.byteLength, 0)
    this.sock.write(Buffer.concat([header, body]))
  }

  async readMessage(): Promise<any> {
    return new Promise((resolve, reject) => {
      this.readingQueue.put([resolve, reject])
    })
  }

  close() {
    this.sock.end()
  }
}

export class TransportEndError extends Error {}

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
