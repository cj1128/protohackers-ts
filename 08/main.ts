import { createServer, Socket } from "node:net"
import assert from "assert"
import { escapeLeadingUnderscores } from "typescript"

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

// will throw if buf is not a valid ciper spec
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

function reverseByte(byte: number) {
  byte = ((byte & 0b11110000) >> 4) | ((byte & 0b00001111) << 4)
  byte = ((byte & 0b11001100) >> 2) | ((byte & 0b00110011) << 2)
  byte = ((byte & 0b10101010) >> 1) | ((byte & 0b01010101) << 1)
  return byte
}

export class Cipher {
  private encodePos = 0
  private decodePos = 0
  private operations: Operation[] = []

  constructor(spec: Buffer) {
    this.operations = parseCipherSpec(spec)
  }

  // will increase encodePos
  encode(input: Buffer) {
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
    this.encodePos += input.length
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

const server = createServer(async (socket) => {
  // const clientId = clientIdSeed++
  // function log(...msgs: any[]) {
  //   console.log(`[${clientId}]`, ...msgs)
  // }
})

const PORT = 8888

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`)
})
