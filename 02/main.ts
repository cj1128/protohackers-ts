import { createServer, Socket } from "node:net"
import { fromInt32 } from "../utils"

type Message = {
  type: string
  int1: number
  int2: number
}

const MSG_LENGTH = 9
async function* readMessage(socket: Socket): AsyncGenerator<Message> {
  let buffer = Buffer.alloc(0)

  for await (const chunk of socket) {
    buffer = Buffer.concat([buffer, chunk])

    while (buffer.byteLength >= MSG_LENGTH) {
      const type = String.fromCharCode(buffer[0]!)
      // make sure to use `buffer.byteOffset + 1` instead of `1`
      const dv = new DataView(buffer.buffer, buffer.byteOffset + 1, 8)
      const int1 = dv.getInt32(0, false) // false means big-endian
      const int2 = dv.getInt32(4, false)

      yield { type, int1, int2 }

      buffer = buffer.subarray(MSG_LENGTH)
    }
  }

  if (buffer.length > 0) {
    // discard
  }
}

let clientIdSeed = 0
const server = createServer(async (socket) => {
  const clientId = clientIdSeed++
  function log(...msgs: any[]) {
    console.log(`[${clientId}]`, ...msgs)
  }

  const records: Map<number, number> = new Map()

  for await (const msg of readMessage(socket)) {
    log("Received msg:", msg)

    switch (msg.type) {
      case "I":
        {
          const ts = msg.int1
          const price = msg.int2

          // undefined behaviour
          if (records.has(ts)) {
            log("undefined behaviour")
            socket.end()
            return
          }

          records.set(ts, price)
        }
        break

      case "Q":
        {
          const minTime = msg.int1
          const maxTime = msg.int2

          let total = 0,
            count = 0
          if (minTime <= maxTime) {
            records.forEach((price, ts) => {
              if (ts >= minTime && ts <= maxTime) {
                total += price
                count++
              }
            })
          }

          let mean = 0
          if (count > 0) {
            mean = Math.ceil(total / count)
          }

          log("send result", mean)
          socket.write(fromInt32(mean, false))
        }
        break

      default:
        {
          log("invalid msg, undefined behaviour")
          socket.end()
        }
        break
    }
  }

  socket.on("error", (err) => {
    console.error("Socket error:", err)
  })
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`TCP echo server listening on port ${PORT}`)
})
