import { createServer } from "node:net"

const server = createServer((socket) => {
  console.log("Client connected:", socket.remoteAddress, socket.remotePort)

  socket.on("data", (data) => {
    console.log("Received:", data)
    socket.write(data)
  })

  socket.on("end", () => {
    console.log("Client disconnected")
  })

  socket.on("error", (err) => {
    console.error("Socket error:", err)
  })
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`00: server listening on port ${PORT}`)
})
