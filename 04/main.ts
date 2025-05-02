import dgram from "dgram"

const server = dgram.createSocket("udp4")

const VERSION = "Ken's Key-Value Store 1.0"
const VERSION_KEY = "version"

const db = new Map<string, string>()
db.set(VERSION_KEY, VERSION)

// sponds to a single UDP datagram
server.on("message", (buf, rinfo) => {
  const str = buf.toString()
  console.log(`Received: ${str} from ${rinfo.address}:${rinfo.port}`)

  function send(msg: string) {
    server.send(msg, rinfo.port, rinfo.address, (err) => {
      if (err) console.error("Send error:", err)
    })
  }

  const idx = str.indexOf("=")

  // retrieve
  if (idx === -1) {
    const key = str
    const value = db.get(key) ?? ""
    send(`${key}=${value}`)
  } else {
    // insert
    const key = str.slice(0, idx)
    const value = str.slice(idx + 1)
    if (key !== VERSION_KEY) {
      db.set(key, value)
    }
  }
})

server.on("listening", () => {
  const address = server.address()
  console.log(`UDP server listening on ${address.address}:${address.port}`)
})

server.bind(8888)
