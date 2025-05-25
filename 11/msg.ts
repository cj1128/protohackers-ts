import { SocketNoDataError, SocketReader } from "../utils"
import { createServer, type Socket } from "node:net"
import assert from "assert"
import { escapeLeadingUnderscores } from "typescript"
import type { MessageEventSource } from "bun"

type u32 = number
type u8 = number

type Message =
  | MessageHello
  | MessageOk
  | MessageTargetPopulations
  | MessagePolicyResult
  | MessageSiteVisit
  | MessageError

type MessageError = {
  type: MessageType.error
  error: string
}
type MessageHello = { type: MessageType.hello; protocol: string; version: u32 }
type MessageOk = { type: MessageType.ok }
type MessagePolicyResult = {
  type: MessageType.policyResult
  policy: u32
}
export type MessageSiteVisit = {
  type: MessageType.siteVisit
  site: u32
  populations: PopulationReport[]
}
type PopulationReport = {
  species: string
  count: u32
}

type PopulationTarget = {
  species: string
  min: u32
  max: u32
}
type MessageTargetPopulations = {
  type: MessageType.targetPopulations
  site: number
  populations: PopulationTarget[]
}

export enum MessageType {
  hello = 0x50,
  error = 0x51,
  ok = 0x52,
  dialAuthority = 0x53,
  targetPopulations = 0x54,
  createPolicy = 0x55,
  deletePolicy = 0x56,
  policyResult = 0x57,
  siteVisit = 0x58,
}

export enum PolicyAction {
  cull = 0x90,
  conserve = 0xa0,
}

export const MessageEncoder = {
  hello() {
    return this.encode(
      MessageType.hello,
      Buffer.concat([this.str("pestcontrol"), this.u32(1)])
    )
  },

  deletePolicy(policy: u32) {
    return this.encode(MessageType.deletePolicy, this.u32(policy))
  },

  createPolicy(species: string, action: PolicyAction) {
    return this.encode(
      MessageType.createPolicy,
      Buffer.concat([this.str(species), Buffer.from([action])])
    )
  },

  error(str: string): Buffer {
    return this.encode(MessageType.error, MessageEncoder.str(str))
  },

  dialAuthority(site: number) {
    return this.encode(MessageType.dialAuthority, MessageEncoder.u32(site))
  },

  siteVisit(site: u32, populations: PopulationReport[]) {
    return this.encode(
      MessageType.siteVisit,
      Buffer.concat([
        this.u32(site),
        this.arr(
          populations.map((r) => [r.species, r.count]),
          ["string", "u32"]
        ),
      ])
    )
  },
  //
  // helpers
  //
  arr(data: any[], fields: ("string" | "u32")[]) {
    let result = this.u32(data.length)

    for (const r of data) {
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        if (field === "string") {
          result = Buffer.concat([result, this.str(r[i])])
        } else if (field === "u32") {
          result = Buffer.concat([result, this.u32(r[i])])
        } else {
          throw new Error("invalid field:" + field)
        }
      }
    }
    return result
  },

  encode(type: u8, payload: Buffer): Buffer {
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

// all message parsers will throw

export function parseMessageSiteVisit(buf: Buffer): MessageSiteVisit {
  validateCheckSumWillThrow(buf)

  assert.ok(buf.length >= 14)
  const payloadBuf = buf.subarray(5)

  const site = payloadBuf.readUint32BE()

  const arrReader = new ArrReader(payloadBuf.subarray(4, -1), ["str", "u32"])

  const readResult = arrReader.read()

  const populations: PopulationReport[] = readResult.map((line) => ({
    species: line[0],
    count: line[1],
  }))

  return {
    type: MessageType.siteVisit,
    site,
    populations,
  }
}

export function parseMessageTargetPopulations(
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

  const populations: PopulationTarget[] = readResult.map((line) => ({
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

export function parseMessagePolicyResult(buf: Buffer): MessagePolicyResult {
  validateCheckSumWillThrow(buf)

  assert.ok(buf.length === 10)
  const payloadBuf = buf.subarray(5)

  const policy = payloadBuf.readUInt32BE()

  return {
    type: MessageType.policyResult,
    policy,
  }
}

export function parseMessageOk(buf: Buffer): MessageOk {
  validateCheckSumWillThrow(buf)

  assert.ok(buf.length === 6)
  return {
    type: MessageType.ok,
  }
}

export function parseMessageError(buf: Buffer): MessageError {
  validateCheckSumWillThrow(buf)

  assert.ok(buf.length >= 10)
  const payloadBuf = buf.subarray(5)

  const strLen = payloadBuf.readUInt32BE()
  assert.ok(strLen === buf.length - 10)

  const error = payloadBuf.subarray(4, 4 + strLen).toString()

  return {
    type: MessageType.error,
    error,
  }
}

export function parseMessageHello(buf: Buffer): MessageHello {
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
    // console.log("=== while ===")
    try {
      const firstBuf = await reader.read(5)
      const length = firstBuf.readUInt32BE(1)
      assert.ok(length > 5)
      const payloadBuf = await reader.read(length - 5)
      const buf = Buffer.concat([firstBuf, payloadBuf])

      const typeByte = firstBuf[0]

      switch (typeByte) {
        case MessageType.siteVisit:
          {
            yield parseMessageSiteVisit(buf)
          }
          break
        case MessageType.policyResult:
          {
            yield parseMessagePolicyResult(buf)
          }
          break
        case MessageType.targetPopulations:
          {
            yield parseMessageTargetPopulations(buf)
          }
          break
        case MessageType.ok:
          {
            yield parseMessageOk(buf)
          }
          break
        case MessageType.hello:
          {
            yield parseMessageHello(buf)
          }
          break
        case MessageType.error:
          {
            yield parseMessageError(buf)
          }
          break
      }
    } catch (err) {
      if (err instanceof SocketNoDataError) {
        // yield { type: "error", msg: "no data in socket" }
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
