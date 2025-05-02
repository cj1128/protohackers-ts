import { createServer, Socket } from "node:net"
import { LineReader } from "../utils.ts"

async function* readLines(socket: Socket): AsyncGenerator<string> {
  const lineReader = new LineReader()

  for await (const chunk of socket) {
    lineReader.append(chunk)

    let line
    while ((line = lineReader.readLine()) !== null) {
      yield line
    }
  }

  // discard remaining data
}

function writeMsg(socket: Socket, msg: string) {
  socket.write(msg + "\n")
}

function isValidUsername(name: string): boolean {
  return /^[a-zA-Z0-9]{1,1024}$/.test(name)
}

const clients = new Map<string, Socket>()
const server = createServer(async (socket) => {
  console.log("Client connected")

  let username

  // prompt user anme
  {
    writeMsg(socket, "Welcome to budgetchat! What shall I call you?")
    const linesGenerator = readLines(socket)
    username = (await linesGenerator.next()).value

    // client closes socket
    if (username === undefined) {
      socket.end()
      return
    }
    if (!isValidUsername(username)) {
      writeMsg(socket, "error: username is invalid")
      socket.end()
      return
    }
    if (clients.has(username)) {
      writeMsg(socket, "error: username already exists")
      socket.end()
      return
    }
  }

  // user has joined
  {
    // lists all present users' names
    const names = [...clients.keys()].join(", ")
    writeMsg(socket, `* The room contains: ${names}`)

    // send all other users a message to inform them that the user has joined
    clients.forEach((s) => {
      writeMsg(s, `* ${username} has entered the room`)
    })

    clients.set(username, socket)
  }

  // A user leaves
  socket.on("end", () => {
    clients.delete(username)
    clients.forEach((s) => {
      writeMsg(s, `* ${username} has left the room`)
    })
  })

  socket.on("error", (err) => {
    clients.delete(username)
    console.error("Socket error:", err)
  })

  for await (const line of readLines(socket)) {
    clients.forEach((s) => {
      // not current client
      if (s !== socket) {
        writeMsg(s, `[${username}] ${line}`)
      }
    })
  }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`03: server listening on port ${PORT}`)
})
