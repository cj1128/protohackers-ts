import assert from "assert"
import dgram from "dgram"
import { LineReader } from "../utils"

const RetransmissionTimeout = 3 * 1000 // in ms
const SessionExpiryTimeout = 60 * 1000 // in ms
const LrcpMaxLength = 999

export class Session implements AsyncIterable<string> {
  private queue: string[] = []
  private pendingResolver: ((value: IteratorResult<string>) => void) | null =
    null

  closed = false
  sessionId: number

  private rinfo: dgram.RemoteInfo
  private server: dgram.Socket
  private sendLength: number = 0
  private sendDataMsgs: { msg: Buffer; length: number }[] = []
  private readPos: number = 0
  private lineReader = new LineReader()
  private maxAckLength: number = 0

  constructor(
    server: dgram.Socket,
    rinfo: dgram.RemoteInfo,
    sessionId: number
  ) {
    this.server = server
    this.rinfo = rinfo
    this.sessionId = sessionId
  }

  // read
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        if (this.closed) return { value: undefined, done: true }
        if (this.queue.length > 0) {
          return { value: this.queue.shift()!, done: false }
        }
        return new Promise((resolve) => {
          this.pendingResolver = resolve
        })
      },
    }
  }

  // will split into multiple 'data' mesasge
  write(str: string) {
    const MAX_PAYLOAD = 950
    let payload = Buffer.from(str)
    while (payload.length > MAX_PAYLOAD) {
      this._data(payload.subarray(0, MAX_PAYLOAD))
      payload = payload.subarray(MAX_PAYLOAD)
    }
    this._data(payload)
  }

  _close() {
    this.closed = true
    this.pendingResolver?.({ value: undefined, done: true })
    this.pendingResolver = null
    this.queue = []
  }

  _onData(pos: number, data: string) {
    if (this.readPos === pos) {
      this.readPos += data.length
      this._ack(this.readPos)
      this.lineReader.append(Buffer.from(data))

      let line
      while ((line = this.lineReader.readLine()) != null) {
        // give it to application layer
        this._onLine(line)
      }
    } else {
      this._ack(this.readPos)
    }
  }

  _onAck(length: number) {
    if (length <= this.maxAckLength) {
      // do nothing
      return
    }

    this.maxAckLength = length

    // the peer is misbehaving, close the session
    if (length > this.sendLength) {
      this._close()
      return
    }

    if (length === this.sendLength) {
      // don't send any reply
      return
    }

    // retransmit
    {
      let pos = 0
      for (const lrcp of this.sendDataMsgs) {
        pos += lrcp.length
        if (pos > length) {
          this._rawSend(lrcp.msg)
        }
      }
    }
  }

  _onLine(line: string) {
    if (this.pendingResolver) {
      this.pendingResolver({ value: line, done: false })
      this.pendingResolver = null
    } else {
      this.queue.push(line)
    }
  }

  // send a ack msg
  _ack(pos: number) {
    this._rawSend(`/ack/${this.sessionId}/${pos}/`)
  }

  // a single LRCP 'data' message
  _data(data: Buffer) {
    const msg = Buffer.from(
      `/data/${this.sessionId}/${this.sendLength}/${Session.escapeData(
        data.toString()
      )}/`
    )
    assert.ok(msg.length <= LrcpMaxLength)
    const newSendLength = this.sendLength + data.length
    this.sendLength = newSendLength
    this.sendDataMsgs.push({ msg, length: data.length })
    this._rawSend(msg)

    let intervalId = setInterval(() => {
      if (this.maxAckLength < newSendLength) {
        this._rawSend(msg)
      } else {
        clearInterval(intervalId)
      }
    }, RetransmissionTimeout)

    setTimeout(() => {
      if (this.maxAckLength < newSendLength) {
        this._close()
      }
    }, SessionExpiryTimeout)
  }

  // just send
  _rawSend(msg: string | Buffer) {
    this.server.send(msg, this.rinfo.port, this.rinfo.address)
  }

  static escapeData(input: string): string {
    return input.replaceAll("\\", "\\\\").replaceAll("/", "\\/")
  }
  static unescapeData(input: string): string {
    return input.replaceAll("\\\\", "\\").replaceAll("\\/", "/")
  }
}

const clientMap = new Map()
let clientIdSeed = 0
function getClientId(rinfo: dgram.RemoteInfo) {
  const key = rinfo.address + "." + rinfo.port
  let id = clientMap.get(key)
  if (id == null) {
    id = clientIdSeed++
    clientMap.set(key, id)
  }
  return id
}

export function createLRCPServer(cb: (session: Session) => void): dgram.Socket {
  const server = dgram.createSocket("udp4")
  // key: sessionId
  const sessions = new Map<number, Session>()

  // Each UDP packet contains a single LRCP message
  server.on("message", (buf, rinfo) => {
    const clientId = getClientId(rinfo)
    let session: Session | undefined
    function log(...args: any[]) {
      console.log(`[${session?.sessionId ?? ""}](${clientId})`, ...args)
    }

    const msg = parseMsg(buf)
    log("msg reveied", { raw: buf.toString(), parsed: msg })

    // ignore the packet
    if (msg == null) {
      log("invalid msg, ignored")
      return
    }

    function sendClose(sessionId: number) {
      server.send(`/close/${sessionId}/`, rinfo.port, rinfo.address)
    }

    switch (msg.type) {
      case MsgType.connect:
        {
          session = sessions.get(msg.sessionId)
          if (session == null || session.closed) {
            session = new Session(server, rinfo, msg.sessionId)
            sessions.set(msg.sessionId, session)
            cb(session)
          }
          session._ack(0)
        }
        break
      case MsgType.data:
        {
          session = sessions.get(msg.sessionId)
          if (session == null || session.closed) {
            sendClose(msg.sessionId)
            return
          }

          session._onData(msg.pos, msg.data)
        }
        break
      case MsgType.ack:
        {
          session = sessions.get(msg.sessionId)

          if (session == null || session.closed) {
            sendClose(msg.sessionId)
            return
          }

          session._onAck(msg.length)
          if (session.closed) {
            sendClose(msg.sessionId)
          }
        }
        break
      case MsgType.close:
        {
          sendClose(msg.sessionId)
          sessions.delete(msg.sessionId)
        }
        break
    }
  })

  return server
}

// "/" and "\" must be escaped
function isDataValid(msg: string): boolean {
  const m = msg.replaceAll("\\\\", "").replaceAll("\\/", "")
  return !m.includes("/") && !m.includes("\\")
}

// null means invalid LRCP message
function parseMsg(buf: Buffer): Message | null {
  // LRCP messages must be smaller than 1000 bytes
  if (buf.length >= 1000) {
    return null
  }

  const input = buf.toString()

  // connect
  {
    const m = input.match(/^\/connect\/(\d+)\/$/)
    if (m) {
      const sessionId = parseInt(m[1]!)
      assert.ok(!isNaN(sessionId))
      return { type: MsgType.connect, sessionId }
    }
  }

  // close
  {
    const m = input.match(/^\/close\/(\d+)\/$/)
    if (m) {
      const sessionId = parseInt(m[1]!)
      assert.ok(!isNaN(sessionId))
      return { type: MsgType.close, sessionId }
    }
  }

  // data
  {
    const m = input.match(/^\/data\/(\d+)\/(\d+)\/(.*)\/$/s)
    if (m) {
      const sessionId = parseInt(m[1]!)
      const pos = parseInt(m[2]!)
      if (!isDataValid(m[3]!)) return null
      const data = Session.unescapeData(m[3]!)
      assert.ok(!isNaN(sessionId) && !isNaN(pos))
      return { type: MsgType.data, sessionId, pos, data }
    }
  }

  // ack
  {
    const m = input.match(/^\/ack\/(\d+)\/(\d+)\/$/)
    if (m) {
      const sessionId = parseInt(m[1]!)
      const length = parseInt(m[2]!)
      assert.ok(!isNaN(sessionId) && !isNaN(length))
      return { type: MsgType.ack, sessionId, length }
    }
  }

  return null
}

enum MsgType {
  connect = "connect",
  data = "data",
  ack = "ack",
  close = "close",
}

// non-negative integer
type SessionId = number

type MsgConnect = {
  type: MsgType.connect
  sessionId: SessionId
}
type MsgClose = {
  type: MsgType.close
  sessionId: SessionId
}
type MsgData = {
  type: MsgType.data
  sessionId: SessionId
  pos: number
  data: string
}
type MsgAck = {
  type: MsgType.ack
  sessionId: SessionId
  length: number
}
type Message = MsgConnect | MsgData | MsgClose | MsgAck
