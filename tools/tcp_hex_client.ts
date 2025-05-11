// Run with: bun tcp_hex_client.ts 127.0.0.1 1234

const [_, __, host, portStr] = Bun.argv
if (!host || !portStr) {
  console.error("Usage: bun tcp_hex_client.ts <host> <port>")
  process.exit(1)
}

const port = parseInt(portStr, 10)

const conn = await Bun.connect({
  hostname: host,
  port: port,
  socket: {
    open(socket) {
      console.log(`✅ Connected to ${host}:${port}`)
      prompt()
    },
    data(socket, data) {
      console.log(
        `← Received: ${data.toString("hex")} | ${data.toString("utf8")}`
      )
      prompt()
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
  const hex = line
    .toString()
    .trim()
    .replace(/[\s,]+/g, "")
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    console.log("❌ Invalid hex input")
    prompt()
    return
  }
  const buffer = Buffer.from(hex, "hex")
  conn.write(buffer)
  prompt()
})

function prompt() {
  process.stdout.write("→ HEX> ")
}
