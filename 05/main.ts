import { createServer, createConnection } from "node:net"
import { readLines } from "../utils.ts"

function replaceBoguscoinAddress(str: string): string {
  return str.replaceAll(
    /(?<=^| )7[a-zA-Z0-9]{25,34}(?=$| )/g,
    "7YWHMfk9JZe0LM0g1ZauHuiSxhI"
  )
}

const server = createServer(async (client) => {
  console.log("Client connected")

  const upstream = createConnection(
    {
      host: "chat.protohackers.com",
      port: 16963,
    },
    async () => {
      for await (const line of readLines(upstream)) {
        client.write(replaceBoguscoinAddress(line) + "\n")
      }
    }
  )

  client.on("close", () => {
    upstream.end()
  })
  upstream.on("close", () => {
    client.end()
  })

  for await (const line of readLines(client)) {
    upstream.write(replaceBoguscoinAddress(line) + "\n")
  }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
