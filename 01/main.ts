import { createServer, Socket } from "node:net"
import { tryPraseJSON } from "../utils"

async function* readLines(socket: Socket): AsyncGenerator<Buffer> {
  let buffer = Buffer.alloc(0)

  for await (const chunk of socket) {
    buffer = Buffer.concat([buffer, chunk])

    let index
    // 0x0A = '\n'
    while ((index = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, index)
      buffer = buffer.subarray(index + 1)
      yield line
    }
  }

  if (buffer.length > 0) {
    yield buffer
  }
}

const server = createServer(async (socket) => {
  console.log("Client connected")

  function onMalformed() {
    socket.write("malformed")
    socket.end()
  }

  for await (const buf of readLines(socket)) {
    const line = buf.toString()

    console.log("Received line:", buf.toBase64(), line)

    const [parsed, err] = tryPraseJSON(line)

    if (err != null) {
      onMalformed()
      return
    }

    if (parsed?.method !== "isPrime" || typeof parsed?.number !== "number") {
      onMalformed()
      return
    }

    const res = {
      method: "isPrime",
      prime: Number.isInteger(parsed.number) ? isPrime(parsed.number) : false,
    }

    socket.write(JSON.stringify(res) + "\n")
  }

  socket.on("error", (err) => {
    console.error("Socket error:", err)
  })
})

function isPrime(num: number): boolean {
  if (num <= 1) return false
  if (num <= 3) return true
  if (num % 2 === 0 || num % 3 === 0) return false

  for (let i = 5; i * i <= num; i += 6) {
    if (num % i === 0 || num % (i + 2) === 0) return false
  }

  return true
}

const PORT = 8888

server.listen(PORT, () => {
  console.log(`01: server listening on port ${PORT}`)
})
