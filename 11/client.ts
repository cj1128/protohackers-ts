// Run with: bun tcp_hex_client.ts [127.0.0.1] [1234]
import { readMessage, MessageEncoder } from "./msg"
import { createConnection } from "node:net"

let [_, __, host, portStr] = Bun.argv
host = "127.0.0.1"
portStr = "8888"

const port = parseInt(portStr)

const conn = createConnection({
  host,
  port: port,
})

conn.on("close", () => process.exit(1))

function parseLine(line: string) {
  const result = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      inQuotes = !inQuotes
    } else if (!inQuotes && (char === "," || /\s/.test(char))) {
      if (current !== "") {
        result.push(current)
        current = ""
      }
      // ignore multiple spaces/commas
    } else {
      current += char
    }
  }

  if (current !== "") {
    result.push(current)
  }

  return result
}

// Set up stdin for reading
process.stdin.setEncoding("utf8")
process.stdin.resume()
process.stdin.on("data", (line) => {
  const input = line.toString().trim()
  console.log("got input", { input })
  if (input === "hello") {
    conn.write(MessageEncoder.hello())
    prompt()
    return
  }

  const parsed = parseLine(input)
  if (parsed[0] === "sv") {
    parsed.shift()
    const site = Number(parsed.shift()!)

    const populations = []
    for (let i = 0; i < parsed.length; i += 2) {
      populations.push({
        species: parsed[i]!,
        count: Number(parsed[i + 1]!),
      })
    }

    const buf = MessageEncoder.siteVisit(site, populations)
    conn.write(buf)
    console.log("--> send:", buf.toHex())
    prompt()
  } else {
    // sv 12345 "long-tailed rat",20 "abc dd",40
    conn.write(`usage: hello or sv $site $species,$count $species,$count`)
    prompt()
  }
})

function prompt() {
  process.stdout.write("> ")
}

prompt()

for await (const msg of readMessage(conn)) {
  process.stdout.write(`← Received: ` + JSON.stringify(msg) + "\n")
  prompt()
}
