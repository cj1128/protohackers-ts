import { createLRCPServer } from "./LRCP"

const server = createLRCPServer(async (session) => {
  for await (const line of session) {
    console.log("got line", { sessionId: session.sessionId, line })
    session.write(line.split("").reverse().join("") + "\n")
  }
})

server.on("listening", () => {
  const address = server.address()
  console.log(`LRCP server listening on ${address.address}:${address.port}`)
})

server.bind(8888)
