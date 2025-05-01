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
