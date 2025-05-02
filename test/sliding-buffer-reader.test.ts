import { describe, test, expect, beforeEach } from "bun:test"
import { SlidingBufferReader } from "../utils"

describe("SlidingBufferReader", () => {
  let reader: SlidingBufferReader

  beforeEach(() => {
    reader = new SlidingBufferReader(8)
  })

  test("append and read basic", () => {
    reader.append(Buffer.from([1, 2, 3, 4]))
    expect(reader.read(2)).toEqual(Buffer.from([1, 2]))
    expect(reader.read(2)).toEqual(Buffer.from([3, 4]))
    expect(reader.read(1)).toBeNull()
  })

  test("reading partial data returns null", () => {
    reader.append(Buffer.from([0xaa]))
    expect(reader.available).toBe(1)
    expect(reader.read(2)).toBeNull()
  })

  test("reading across multiple appends", () => {
    reader.append(Buffer.from([1]))
    expect(reader.read(2)).toBeNull()
    reader.append(Buffer.from([2]))
    expect(reader.read(2)).toEqual(Buffer.from([1, 2]))
  })

  test("compact behavior reuses space", () => {
    reader.append(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(reader.read(8)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))

    // buffer should now be reset
    reader.append(Buffer.from([5, 6]))
    expect(reader.read(2)).toEqual(Buffer.from([5, 6]))
    expect(reader.bufferLength).toBe(8)
  })

  test("grows when buffer is too small", () => {
    const b8 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    reader.append(b8)
    expect(reader.read(8)).toEqual(b8)

    const b10 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    // force growth
    reader.append(b10)
    expect(reader.read(10)).toEqual(b10)
    expect(reader.bufferLength).not.toEqual(8)
  })
})
