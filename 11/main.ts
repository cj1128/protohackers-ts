import { createServer, Socket } from "node:net"
import { readMessage } from "./msg"

let clientIdSeed = 0
const server = createServer(async (client) => {
  const clientId = clientIdSeed++
  function log(...args: any[]) {
    console.log(`[${clientId}]`)
  }

  log("client connected")

  for await (const msg of readMessage(client)) {
    console.log("msg parsed", { msg })

    if (msg.type === "error") {
      client.end()
      // break
    }
  }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
