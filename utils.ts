import type { Socket } from "node:net"

export function tryPraseJSON(str: string): [any, unknown | null] {
  try {
    const parsed = JSON.parse(str)
    return [parsed, null]
  } catch (err) {
    return [null, err]
  }
}

export function fromInt32(num: number, littleEndian = true): Uint8Array {
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  view.setInt32(0, num, littleEndian)
  return new Uint8Array(buffer)
}

export class SlidingBufferReader {
  private buffer: Buffer
  private readOffset: number
  private writeOffset: number

  constructor(initSize = 1024) {
    this.buffer = Buffer.alloc(initSize)
    this.readOffset = 0
    this.writeOffset = 0
  }

  append(chunk: Buffer) {
    if (this.writeOffset + chunk.length > this.buffer.length) {
      this.ensureCapacity(chunk.length)
    }
    chunk.copy(this.buffer, this.writeOffset)
    this.writeOffset += chunk.length
  }

  /**
   * Try to read a fixed-length block. Returns `null` if not enough data.
   */
  read(length: number): Buffer | null {
    if (this.available < length) return null

    const slice = this.buffer.subarray(
      this.readOffset,
      this.readOffset + length
    )
    this.readOffset += length

    // Reset offsets if everything consumed
    if (this.readOffset === this.writeOffset) {
      this.readOffset = 0
      this.writeOffset = 0
    }

    return slice
  }
  readU8(): number | null {
    const buf = this.read(1)
    if (buf == null) return null
    return buf[0]!
  }
  readU16BE(): number | null {
    const buf = this.read(2)
    if (buf == null) return null
    return buf.readUint16BE()
  }
  readU32BE(): number | null {
    const buf = this.read(4)
    if (buf == null) return null
    return buf.readUint32BE()
  }

  peek(length: number): Buffer | null {
    if (this.available < length) return null
    return this.buffer.subarray(this.readOffset, this.readOffset + length)
  }

  /**
   * Returns how many unread bytes are currently buffered
   */
  get available(): number {
    return this.writeOffset - this.readOffset
  }

  get bufferLength(): number {
    return this.buffer.length
  }

  /**
   * Ensure buffer has enough space to append `minFreeSpace` bytes
   */
  private ensureCapacity(minFreeSpace: number) {
    const availableHeadroom = this.buffer.length - this.writeOffset
    const unread = this.available

    // 🧹 Try compacting first
    if (availableHeadroom + this.readOffset >= minFreeSpace) {
      this.buffer.copy(this.buffer, 0, this.readOffset, this.writeOffset)
      this.writeOffset = unread
      this.readOffset = 0
      return
    }

    // 📦 Not enough even after compacting — grow
    const newSize = Math.max(this.buffer.length * 2, unread + minFreeSpace)
    const newBuffer = Buffer.alloc(newSize)
    this.buffer.copy(newBuffer, 0, this.readOffset, this.writeOffset)
    this.buffer = newBuffer
    this.writeOffset = unread
    this.readOffset = 0
  }
}

export class LineReader {
  private readonly reader = new SlidingBufferReader()

  append(chunk: Buffer) {
    this.reader.append(chunk)
  }

  // "\n" separated lines
  readLine(): string | null {
    const buffer = this.reader.peek(this.reader.available)!
    const newlineIndex = buffer.indexOf(0x0a) // \n

    if (newlineIndex === -1) return null

    const line = this.reader.read(newlineIndex)!.toString()
    this.reader.read(1) // discard "\n"

    return line
  }
}

export async function* readLines(socket: Socket): AsyncGenerator<string> {
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
