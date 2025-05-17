import { createServer, Socket } from "node:net"
import { SlidingBufferReader } from "../utils"
import path from "node:path"
import assert from "assert"

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
  | { type: MethodType.get; filename: string; revision?: string }
  | { type: MethodType.list; dir: string }
  | { type: MethodType.illegal; method: string }
  | { type: MethodType.error; err: string; appendReady: boolean }

function isValidText(buf: Buffer): boolean {
  // 0x0a: "\n" line feed
  // 0x09: "\t"
  return buf.every((b) => b === 0x0a || b === 0x09 || (b >= 0x20 && b < 0x7f))
}

function isValidFileName(name: string): boolean {
  return /^[a-zA-Z0-9-_.]+$/.test(name)
}

function isValidFilePath(input: string): boolean {
  if (!input.startsWith("/")) return false

  const parts = input.split("/")
  parts.shift() // discard the first empty string

  // each part must be a valid filename
  return parts.every((p) => isValidFileName(p))
}

function isValidDirPath(input: string) {
  if (!input.startsWith("/")) return false

  const parts = input.split("/")
  parts.shift() // discard the first empty string

  // means dir has a trailing '/'
  if (parts.at(-1) === "") {
    parts.pop()
  }

  // each part must be a valid filename
  return parts.every((p) => isValidFileName(p))
}

// input does not have newline
function parseMethod(input: string): Method {
  const parts = input.trimEnd().split(" ")

  const rawCmd = parts[0]!
  const cmd = rawCmd.toLocaleLowerCase()

  if (cmd === MethodType.help) {
    return { type: MethodType.help }
  }

  // put
  if (cmd === MethodType.put) {
    if (parts.length !== 3) {
      return {
        type: MethodType.error,
        err: "usage: PUT file length newline data",
        appendReady: true,
      }
    }

    const filename = parts[1]!

    // ignore parse error, will treat error as 0
    let length = parseInt(parts[2]!)
    if (Number.isNaN(length)) {
      length = 0
    }

    return { type: MethodType.put, filename, length }
  }

  // get
  if (cmd === "get") {
    if (parts.length !== 2 && parts.length !== 3) {
      return {
        type: MethodType.error,
        err: "usage: GET file [revision]",
        appendReady: true,
      }
    }

    const filename = parts[1]!
    const revision = parts[2]
    return { type: MethodType.get, filename, revision }
  }

  // list
  if (cmd === "list") {
    if (parts.length !== 2) {
      return {
        type: MethodType.error,
        err: "usage: LIST dir",
        appendReady: true,
      }
    }

    return { type: MethodType.list, dir: parts[1]! }
  }

  return { type: MethodType.illegal, method: rawCmd }
}

// filename, last revision
const _metaStore = new Map<string, number>()

// key: filename + revision, data
const _fileStore = new Map<string, string>()

function getLastRevision(filename: string): number | undefined {
  return _metaStore.get(filename)
}

// dir may not end in '/'
function listFilesInDir(dir: string): string[] {
  assert.ok(dir.endsWith("/"))

  const result: string[] = []
  _fileStore.forEach((_, key) => {
    const filename = key.split("#")[0]!
    if (filename.startsWith(dir)) {
      result.push(filename.slice(dir.length))
    }
  })
  return result
}

function buildFileKey(filename: string, revision: number) {
  return `${filename}#${revision}`
}

// return string
function saveFile(filename: string, data: string): number {
  const lastRevision = _metaStore.get(filename)

  // this is the first version
  if (lastRevision == null) {
    const key = buildFileKey(filename, 1)
    _fileStore.set(key, data)
    _metaStore.set(filename, 1)
    return 1
  }

  const lastData = getFile(filename, lastRevision)
  // no need to store
  if (data === lastData) {
    return lastRevision
  }

  const revision = lastRevision + 1
  const key = buildFileKey(filename, revision)
  _fileStore.set(key, data)
  _metaStore.set(filename, revision)
  return revision
}
function getFile(filename: string, revision: number): undefined | string {
  return _fileStore.get(buildFileKey(filename, revision))
}

let clientIdSeed = 0
const server = createServer(async (socket) => {
  const clientId = clientIdSeed++

  function log(...args: any[]) {
    console.log(`[${clientId}]`, ...args)
  }

  function write(msg: string, newline = true) {
    socket.write(msg + (newline ? "\n" : ""))
  }

  log("client connected")
  write("READY")

  const reader = new SlidingBufferReader()

  const iterator = socket[Symbol.asyncIterator]()
  while (true) {
    let iteratorValue
    const line = reader.readLine()
    if (line == null) {
      iteratorValue = await iterator.next()
      if (iteratorValue.done) {
        break
      }

      let chunk = iteratorValue.value
      reader.append(chunk)
      continue
    }

    const method = parseMethod(line)
    log("got line", { line, method })

    switch (method.type) {
      case MethodType.illegal: {
        write(`ERR illegal method: ${method.method}`)
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
          if (!isValidFilePath(filename)) {
            write(`ERR illegal file name`)
            continue
          }

          let data = ""

          // read length bytes, must be valid ASCII chars
          // can not be control characters
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
              log("got buf", { buf, str: buf.toString() })
              if (isValidText(buf)) {
                data = buf.toString()
                break
              } else {
                write(`ERR text files only`)
                write("READY")
              }
            }
          }

          const revision = saveFile(filename, data)
          write(`OK r${revision}`)
          write("READY")
        }
        break
      case MethodType.get:
        {
          if (!isValidFilePath(method.filename)) {
            write(`ERR illegal file name`)
            continue
          }

          const filename = method.filename

          // no such file
          const lastRevision = getLastRevision(filename)
          if (lastRevision == null) {
            write(`ERR no such file`)
            continue
          }

          // no such revision
          let revision = lastRevision
          if (method.revision != null) {
            revision = Number(method.revision.slice(1))
          }
          const data = getFile(filename, revision)
          if (data == null) {
            write(`ERR no such revision`)
            continue
          }

          // send
          write(`OK ${data.length}`)
          write(data, false)
          write("READY")
        }
        break
      case MethodType.list:
        {
          let dir = method.dir
          if (!isValidDirPath(dir)) {
            write(`ERR illegal dir name`)
            continue
          }

          // make sure dir ends with '/'
          if (!dir.endsWith("/") && dir.length > 1) {
            dir = dir + "/"
          }

          // sort by filepath ASC
          const allFiles = listFilesInDir(dir).sort(
            (a, b) => a.length - b.length
          )
          log("all files", allFiles)
          // only list file in dir, not recursively
          const result: Set<string> = new Set()
          for (const name of allFiles) {
            // it's a file
            if (!name.includes("/")) {
              result.add(name)
            } else {
              // it's a DIR
              const dirName = name.split("/")[0]!

              // we can both have a file and a dir in one dir
              // e.g.
              // put /a 0
              // put /a/b 0
              // list /
              if (!result.has(dirName)) {
                result.add(dirName + "/")
              }
            }
          }

          write(`OK ${result.size}`)
          // sort in string ASC order
          for (const item of [...result].sort()) {
            const revision = item.endsWith("/")
              ? "DIR"
              : "r" + getLastRevision(dir + item)
            write(`${item} ${revision}`)
          }
          write("READY")
        }
        break
    }
  }

  socket.end()
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
