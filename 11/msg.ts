import { SocketNoDataError, SocketReader } from "../utils"
import { createServer, type Socket } from "node:net"
import assert from "assert"

type u32 = number
type u8 = number

type Message = MessageHello | MessageOk | MessageTargetPopulations

type MessageHello = { type: MessageType.hello; protocol: string; version: u32 }
type MessageOk = { type: MessageType.ok }

type Population = {
  species: string
  min: u32
  max: u32
}
type MessageTargetPopulations = {
  type: MessageType.targetPopulations
  site: number
  populations: Population[]
}

export enum MessageType {
  hello = 0x50,
  error = 0x51,
  ok = 0x52,
  dialAuthority = 0x53,
  targetPopulations = 0x54,
}

export const MessageEncoder = {
  error(str: string): Buffer {
    return this.encode(MessageType.error, MessageEncoder.str(str))
  },
  dialAuthority(site: number) {
    return this.encode(MessageType.dialAuthority, MessageEncoder.u32(site))
  },
  //
  // helpers
  //
  encode(type: u8, payload: Buffer): Buffer {
    const prefix = Buffer.from([MessageType.error])
    // 1 type + 4 length + 1 checksum
    const totalLength = payload.length + 6

    const result = Buffer.concat([
      Buffer.from([type]),
      MessageEncoder.u32(totalLength),
      payload,
      Buffer.from([0]),
    ])

    // fill checksum
    {
      let sum = 0
      for (let i = 0; i < result.length - 1; i++) {
        sum += result[i]!
      }
      result[result.length - 1] = 256 - (sum % 256)
    }

    return result
  },
  str(str: string): Buffer {
    const lenBuf = MessageEncoder.u32(str.length)
    return Buffer.concat([lenBuf, Buffer.from(str)])
  },

  u8(num: number): Uint8Array {
    const buf = Buffer.alloc(1)
    buf.writeUInt8(num)
    return buf
  },
  u16(num: number): Buffer {
    const buf = Buffer.alloc(2)
    buf.writeUInt16BE(num)
    return buf
  },
  u32(num: number): Buffer {
    const buf = Buffer.alloc(4)
    buf.writeUint32BE(num)
    return buf
  },
}

function validateCheckSumWillThrow(buf: Buffer) {
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i]!
  }
  if (sum % 256 !== 0) {
    throw new Error("invalid checksum")
  }
}

type ReadError = {
  type: "error"
  msg: string
  buf?: Buffer
}

// will throw if error occurred
class ArrReader {
  private buf: Buffer
  private fields: string[]
  private idx = 0

  constructor(buf: Buffer, fields: ("str" | "u32")[]) {
    this.buf = buf
    this.fields = fields
  }

  read(): any[][] {
    const result = []
    const arrLength = this.readU32()

    for (let i = 0; i < arrLength; i++) {
      const item = []
      for (const field of this.fields) {
        switch (field) {
          case "str":
            {
              item.push(this.readStr())
            }
            break
          case "u32":
            {
              item.push(this.readU32())
            }
            break
        }
      }
      result.push(item)
    }

    return result
  }

  readStr() {
    const len = this.readU32()
    const buf = this.readBytes(len)
    return buf.toString()
  }
  readU32() {
    const b = this.readBytes(4)
    return b.readUint32BE()
  }
  readBytes(n: number) {
    assert.ok(this.buf.length - this.idx >= n, "no enough bytes")
    const result = this.buf.subarray(this.idx, this.idx + n)
    this.idx += n
    return result
  }
}

export function parseMessageTargetPopulationsWillThrow(
  buf: Buffer
): MessageTargetPopulations {
  validateCheckSumWillThrow(buf)

  assert.ok(buf.length >= 14)
  const payloadBuf = buf.subarray(5)

  const site = payloadBuf.readUint32BE()

  const arrReader = new ArrReader(payloadBuf.subarray(4, -1), [
    "str",
    "u32",
    "u32",
  ])

  const readResult = arrReader.read()

  const populations: Population[] = readResult.map((line) => ({
    species: line[0],
    min: line[1],
    max: line[2],
  }))

  return {
    type: MessageType.targetPopulations,
    site,
    populations,
  }
}

export function parseMessageHelloWillThrow(buf: Buffer): MessageHello {
  validateCheckSumWillThrow(buf)

  assert.ok(buf.length >= 14)
  const payloadBuf = buf.subarray(5)

  const strLen = payloadBuf.readUInt32BE()
  assert.ok(strLen === buf.length - 14)

  const protocol = payloadBuf.subarray(4, 4 + strLen).toString()
  const version = payloadBuf.readUInt32BE(4 + strLen)

  return {
    type: MessageType.hello,
    protocol,
    version,
  }
}

// return string if error occurred
export async function* readMessage(
  socket: Socket
): AsyncGenerator<Message | ReadError> {
  const reader = new SocketReader(socket)

  while (true) {
    console.log("=== while ===")
    try {
      const typeByte = (await reader.read(1))[0]!
      switch (typeByte) {
        case MessageType.targetPopulations:
          {
            const lengthBuf = await reader.read(4)
            const length = lengthBuf.readUint32BE()

            assert.ok(length >= 5)
            const payloadBuf = await reader.read(length - 5)
          }
          break
        case MessageType.ok:
          {
            const lengthBuf = await reader.read(4)

            const length = lengthBuf.readUint32BE()
            assert.ok(length === 6)

            const payloadBuf = await reader.read(1)

            const fullBuf = Buffer.concat([
              Buffer.from([typeByte]),
              lengthBuf,
              payloadBuf,
            ])

            yield {
              type: MessageType.ok,
            }
          }
          break
        case MessageType.hello:
          {
            const lengthBuf = await reader.read(4)
            const length = lengthBuf.readUint32BE()

            assert.ok(length > 5)
            const payloadBuf = await reader.read(length - 5)

            const fullBuf = Buffer.concat([
              Buffer.from([typeByte]),
              lengthBuf,
              payloadBuf,
            ])

            yield parseMessageHelloWillThrow(fullBuf)
          }
          break
      }
    } catch (err) {
      if (err instanceof SocketNoDataError) {
        yield { type: "error", msg: "no data in socket" }
        return
      }

      yield {
        type: "error",
        msg: (err as Error).message,
      }
      return
    }
  }
}
