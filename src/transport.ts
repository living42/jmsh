import { Socket } from 'net'

export class Transport {
  sock: Socket
  readingQueue: Queue

  constructor(sock: Socket) {
    this.sock = sock
    this.readingQueue = new Queue()

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
      const data = JSON.parse(payload.toString())
      const [resolve, _] = await this.readingQueue.pop()
      resolve(data)
    })
  }

  async postMessage(message: any) {
    const payload = JSON.stringify(message)
    this.sock.write(payload)
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
