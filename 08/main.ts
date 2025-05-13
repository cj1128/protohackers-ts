import { createServer } from "node:net"
import assert from "assert"
import { LineReader, reverseByte } from "../utils"
import _ from "lodash"

export enum OperationType {
  reversebits,
  xorN,
  xorpos,
  addN,
  addpos,
}
type Operation =
  | { type: OperationType.reversebits }
  | { type: OperationType.xorN; n: number }
  | { type: OperationType.xorpos }
  | { type: OperationType.addN; n: number }
  | { type: OperationType.addpos }

// will throw if 'spec' is not a valid ciper spec
export function parseCipherSpec(spec: Buffer): Operation[] {
  const result: Operation[] = []
  let i = 0
  while (i < spec.length) {
    const b = spec[i++]
    switch (b) {
      case 0x00:
        {
          // end of cipher spec
          if (i !== spec.length) {
            throw new Error("0x00 is not the last byte")
          }
        }
        break
      case 0x01:
        {
          result.push({ type: OperationType.reversebits })
        }
        break
      case 0x02:
        {
          const n = spec[i++]
          assert.ok(n != null)
          result.push({ type: OperationType.xorN, n })
        }
        break
      case 0x03:
        {
          result.push({ type: OperationType.xorpos })
        }
        break
      case 0x04:
        {
          const n = spec[i++]
          assert.ok(n != null)
          result.push({ type: OperationType.addN, n })
        }
        break
      case 0x05:
        {
          result.push({ type: OperationType.addpos })
        }
        break
      default:
        {
          throw new Error("invalid ciper spec byte:" + b)
        }
        break
    }
  }
  return result
}

export class Cipher {
  private encodePos = 0
  private decodePos = 0
  private operations: Operation[] = []

  constructor(spec: Buffer) {
    this.operations = parseCipherSpec(spec)
  }

  encode(input: Buffer, increasePos = true) {
    const result = Buffer.from(input)
    const pos = this.encodePos
    for (const op of this.operations) {
      switch (op.type) {
        case OperationType.reversebits:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = reverseByte(result[i]!)
            }
          }
          break
        case OperationType.xorN:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = result[i]! ^ op.n
            }
          }
          break
        case OperationType.xorpos:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = result[i]! ^ (pos + i)
            }
          }
          break
        case OperationType.addN:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = result[i]! + op.n
            }
          }
          break
        case OperationType.addpos:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = result[i]! + (pos + i)
            }
          }
          break
      }
    }
    if (increasePos) {
      this.encodePos += input.length
    }
    return result
  }

  // will increase decodePos
  decode(input: Buffer) {
    const result = Buffer.from(input)
    const pos = this.decodePos
    for (const op of [...this.operations].reverse()) {
      switch (op.type) {
        case OperationType.reversebits:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = reverseByte(result[i]!)
            }
          }
          break
        case OperationType.xorN:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = result[i]! ^ op.n
            }
          }
          break
        case OperationType.xorpos:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = result[i]! ^ (pos + i)
            }
          }
          break
        case OperationType.addN:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = result[i]! - op.n
            }
          }
          break
        case OperationType.addpos:
          {
            for (let i = 0; i < result.length; i++) {
              result[i] = result[i]! - (pos + i)
            }
          }
          break
      }
    }
    this.decodePos += input.length
    return result
  }
}

function findCipherSpecIdx(buf: Buffer) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x00) return i
    // skip one
    if (buf[i] === 0x02 || buf[i] === 0x04) {
      i++
    }
  }
  return -1
}

let clientIdSeed = 0
const server = createServer(async (socket) => {
  const clientId = clientIdSeed++
  let buf = Buffer.alloc(0)
  let cipher
  let lineReader

  function log(...args: any[]) {
    console.log(`[${clientId}]`, ...args)
  }

  for await (const chunk of socket) {
    log("got data", { chunk })

    if (cipher == null || lineReader == null) {
      buf = Buffer.concat([buf, chunk])
      const idx = findCipherSpecIdx(buf)
      if (idx >= 0) {
        const cipherSpec = buf.subarray(0, idx)
        cipher = new Cipher(cipherSpec)
        lineReader = new LineReader()
        lineReader.append(cipher.decode(buf.subarray(idx + 1)))
        log("cipher inited", { spec: cipherSpec })

        // check no-op cipher
        {
          const test = Buffer.from([0x01, 0x02, 0x03, 0x04])
          if (cipher.encode(test, false).equals(test)) {
            log("error: no-op cipher found")
            socket.end()
            return
          }
        }
      }
    } else {
      lineReader.append(cipher.decode(chunk))
      let line
      while ((line = lineReader.readLine()) !== null) {
        const toys = line.split(",")
        const sorted = _.orderBy(toys, [(str) => parseInt(str)], ["desc"])
        const reply = sorted[0] + "\n"
        log("got line", { line, reply })
        socket.write(cipher.encode(Buffer.from(reply)))
      }
    }
  }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
