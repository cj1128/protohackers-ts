import { createServer, Socket } from "node:net"
import { SlidingBufferReader } from "../utils"

enum MethodType {
  help = "help",
  get = "get",
  put = "put",
  list = "list",
  //
  illegal = "illegal",
  error = "error",
}
type Method =
  | { type: MethodType.help }
  | {
      type: MethodType.put
      filename: string
      length: number
    }
  | { type: MethodType.illegal; command: string }
  | { type: MethodType.error; err: string; appendReady: boolean }

function isValidFileName(input: string): boolean {
  return input.startsWith("/") && !input.endsWith("/")
}

function isValidDirName(input: string) {
  return input.startsWith("/") && input.endsWith("/")
}

// input does not have newline
function parseMethod(input: string): Method {
  input = input.toLowerCase()

  const parts = input.split(" ")

  const rawCmd = parts[0]!
  const cmd = rawCmd.toLocaleLowerCase()

  if (cmd === MethodType.help) {
    return { type: MethodType.help }
  }

  // put
  if (cmd === MethodType.put) {
    if (parts.length < 3) {
      return {
        type: MethodType.error,
        err: "usage: PUT file length newline data",
        appendReady: true,
      }
    }

    const filename = parts[1]!
    if (!isValidFileName(filename)) {
      return {
        type: MethodType.error,
        err: "illegal file name",
        appendReady: false,
      }
    }

    // ignore parse error, will treat error as 0
    let length = parseInt(parts[2]!)
    if (Number.isNaN(length)) {
      length = 0
    }

    return { type: MethodType.put, filename, length }
  }

  // get
  if (cmd === "get") {
    if (parts.length < 2) {
      return {
        type: MethodType.error,
        err: "usage: GET file [revision]",
        appendReady: true,
      }
    }

    const filename = parts[0]!
    if (!isValidFileName(filename)) {
      return {
        type: MethodType.error,
        err: "illegal file name",
        appendReady: false,
      }
    }
  }

  return { type: MethodType.illegal, command: rawCmd }
}

// filename, last revision
const metaStore = new Map<string, number>()

// key: filename + revision, data
const fileStore = new Map<string, string>()

// return string
function saveFile(filename: string, data: string): number {
  const lastRevision = metaStore.get(filename)

  // this is the first version
  if (lastRevision == null) {
    const key = fileSaveKey(filename, 1)
    fileStore.set(key, data)
    metaStore.set(filename, 1)
    return 1
  }

  const lastData = getFile(filename, lastRevision)
  // no need to store
  if (data === lastData) {
    return lastRevision
  }

  const revision = lastRevision + 1
  const key = fileSaveKey(filename, revision)
  fileStore.set(key, data)
  metaStore.set(filename, revision)
  return revision
}
function fileSaveKey(filename: string, revision: number) {
  return `${filename}.${revision}`
}
function getFile(filename: string, revision: number): undefined | string {
  return fileStore.get(fileSaveKey(filename, revision))
}

let clientIdSeed = 0
const server = createServer(async (socket) => {
  const clientId = clientIdSeed++

  function log(...args: any[]) {
    console.log(`[${clientId}}]`, ...args)
  }

  function write(msg: string) {
    socket.write(msg + "\n")
  }

  log("client connected")
  write("READY")

  const reader = new SlidingBufferReader()

  const iterator = socket[Symbol.asyncIterator]()
  let iteratorValue = await iterator.next()
  while (!iteratorValue.done) {
    let chunk = iteratorValue.value
    reader.append(chunk)

    const line = reader.readLine()
    if (line == null) {
      continue
    }

    const method = parseMethod(line)
    console.log("got line", { line, cmd: method })

    switch (method.type) {
      case MethodType.illegal: {
        write(`ERR illegal method: ${line}`)
        socket.end()
        return
      }
      case MethodType.help:
        {
          write(`OK usage: HELP|GET|PUT|LIST`)
          write("READY")
        }
        break
      case MethodType.error:
        {
          write(`ERR ${method.err}`)
          if (method.appendReady) {
            write("READY")
          }
        }
        break
      case MethodType.put:
        {
          const { filename, length } = method
          let data = ""

          // read length bytes
          while (length > 0) {
            const buf = reader.read(length)

            // no sufficient data
            if (buf == null) {
              iteratorValue = await iterator.next()

              // client has closed the connection
              if (iteratorValue.done) {
                socket.end()
                return
              }

              reader.append(iteratorValue.value)
            } else {
              data = buf.toString()
              break
            }
          }

          const revision = saveFile(filename, data)
          write(`OK r${revision}`)
          write("READY")
        }
        break
    }

    iteratorValue = await iterator.next()
  }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
