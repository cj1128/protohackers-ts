// bun-tcp-stress.ts

import type { TCPSocket } from "bun"

const HOST = "127.0.0.1"
const PORT = 8888
let CONNECTIONS = 1
const HOLD_DURATION_MS = 1000 // 保持连接时间（毫秒）

if (Bun.argv.length > 2) {
  CONNECTIONS = parseInt(Bun.argv[2]!)
}

const sockets: TCPSocket[] = []
let successCount = 0
let failCount = 0

async function createConnection(id: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = Bun.connect({
      hostname: HOST,
      port: PORT,
      socket: {
        open(sock) {
          sockets.push(sock) // 保存连接保持活跃
          successCount++
          resolve()
        },
        connectError(_, err) {
          console.error(`[#${id}] Connection error`, err)
          failCount++
          resolve() // 不 reject，继续其他连接
        },
        data() {
          // ignore
        },
      },
    })
  })
}

async function main() {
  console.log(
    `🔄 Attempting ${CONNECTIONS} simultaneous TCP connections to ${HOST}:${PORT}...`
  )

  const tasks: Promise<void>[] = []

  for (let i = 0; i < CONNECTIONS; i++) {
    tasks.push(createConnection(i))
  }

  await Promise.all(tasks)

  console.log(`\n✅ Connected: ${successCount}`)
  console.log(`❌ Failed:    ${failCount}`)
  console.log(
    `🟡 Holding connections for ${HOLD_DURATION_MS / 1000} seconds...\n`
  )

  await new Promise((r) => setTimeout(r, HOLD_DURATION_MS))

  for (const sock of sockets) {
    sock.end()
  }

  console.log("🔚 All connections closed.")
}

main()
