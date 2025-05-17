// Run with: bun tcp_hex_client.ts [127.0.0.1] [1234]

let [_, __, host, portStr] = Bun.argv
host = host || "vcs.protohackers.com"
portStr = portStr || "30307"

const port = parseInt(portStr)

let firstDataOfReceive = true
const conn = await Bun.connect({
  hostname: host,
  port: port,
  socket: {
    open(socket) {
      console.log(`✅ Connected to ${host}:${port}`)
      prompt()
    },
    data(socket, data) {
      if (firstDataOfReceive) {
        firstDataOfReceive = false
        process.stdout.write(`← Received: `)
      }

      process.stdout.write(data)

      if (data.toString().endsWith("\n")) {
        firstDataOfReceive = true
        prompt()
      }
    },
    close(socket) {
      console.log("❌ Connection closed")
      process.exit(0)
    },
    error(socket, err) {
      console.error("❗ Socket error:", err)
      process.exit(1)
    },
  },
})

// Set up stdin for reading
process.stdin.setEncoding("utf8")
process.stdin.resume()
process.stdin.on("data", (line) => {
  let input: string | Buffer = line.toString()
  if (input.startsWith("hex")) {
    input = Buffer.from(input.slice(3), "hex")
  }
  console.log(`send: ${JSON.stringify(input)}`)
  conn.write(Buffer.from(input))
  prompt()
})

function prompt() {
  process.stdout.write("> ")
}
