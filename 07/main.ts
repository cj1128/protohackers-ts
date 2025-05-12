import { createLRCPServer } from "./LRCP"
import { LineReader } from "../utils"

const server = createLRCPServer(async (session) => {
  const reader = new LineReader()
  let line
  for await (const data of session) {
    reader.append(Buffer.from(data))
    while ((line = reader.readLine()) != null) {
      console.log("got line", { line })
      session.write(line.split("").reverse().join("") + "\n")
    }
  }
})

server.on("listening", () => {
  const address = server.address()
  console.log(`LRCP server listening on ${address.address}:${address.port}`)
})

server.bind(8888)
