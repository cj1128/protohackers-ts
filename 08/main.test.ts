import { expect, test, describe } from "bun:test"
import { OperationType, parseCipherSpec, Cipher } from "./main"

describe("Cipher", () => {
  test("encode1", () => {
    const c = new Cipher(Buffer.from([0x02, 0x01, 0x01, 0x00]))
    expect(c.encode(Buffer.from("hello"))).toEqual(
      Buffer.from([0x96, 0x26, 0xb6, 0xb6, 0x76])
    )
  })
  test("encode2", () => {
    const c = new Cipher(Buffer.from([0x05, 0x05, 0x00]))
    expect(c.encode(Buffer.from("hello"))).toEqual(
      Buffer.from([0x68, 0x67, 0x70, 0x72, 0x77])
    )
  })
  test("example session", () => {
    const server = new Cipher(Buffer.from([0x02, 0x7b, 0x05, 0x01, 0x00]))
    expect(
      server.decode(
        Buffer.from([
          0xf2, 0x20, 0xba, 0x44, 0x18, 0x84, 0xba, 0xaa, 0xd0, 0x26, 0x44,
          0xa4, 0xa8, 0x7e,
        ])
      )
    ).toEqual(Buffer.from("4x dog,5x car\n"))

    expect(server.encode(Buffer.from("5x car\n"))).toEqual(
      Buffer.from([0x72, 0x20, 0xba, 0xd8, 0x78, 0x70, 0xee])
    )

    expect(
      server.decode(
        Buffer.from([
          0x6a, 0x48, 0xd6, 0x58, 0x34, 0x44, 0xd6, 0x7a, 0x98, 0x4e, 0x0c,
          0xcc, 0x94, 0x31,
        ])
      )
    ).toEqual(Buffer.from("3x rat,2x cat\n"))

    expect(server.encode(Buffer.from("3x rat\n"))).toEqual(
      Buffer.from([0xf2, 0xd0, 0x26, 0xc8, 0xa4, 0xd8, 0x7e])
    )
  })
})

test("parseCipherSpec", () => {
  expect(parseCipherSpec(Buffer.from([0x00]))).toEqual([])
  expect(parseCipherSpec(Buffer.from([0x02, 0x00, 0x00]))).toEqual([
    { type: OperationType.xorN, n: 0 },
  ])
  expect(parseCipherSpec(Buffer.from([0x02, 0xab, 0x02, 0xab, 0x00]))).toEqual([
    { type: OperationType.xorN, n: 0xab },
    { type: OperationType.xorN, n: 0xab },
  ])
  expect(parseCipherSpec(Buffer.from([0x01, 0x01, 0x00]))).toEqual([
    { type: OperationType.reversebits },
    { type: OperationType.reversebits },
  ])
  expect(
    parseCipherSpec(Buffer.from([0x02, 0xa0, 0x02, 0x0b, 0x02, 0xab, 0x00]))
  ).toEqual([
    { type: OperationType.xorN, n: 0xa0 },
    { type: OperationType.xorN, n: 0x0b },
    { type: OperationType.xorN, n: 0xab },
  ])
  expect(parseCipherSpec(Buffer.from([0x05, 0x05, 0x00]))).toEqual([
    { type: OperationType.addpos },
    { type: OperationType.addpos },
  ])
  expect(parseCipherSpec(Buffer.from([0x02, 0x7b, 0x05, 0x01, 0x00]))).toEqual([
    { type: OperationType.xorN, n: 0x7b },
    { type: OperationType.addpos },
    { type: OperationType.reversebits },
  ])
  expect(parseCipherSpec(Buffer.from([0x02, 0x01, 0x01, 0x00]))).toEqual([
    { type: OperationType.xorN, n: 0x01 },
    { type: OperationType.reversebits },
  ])
})
