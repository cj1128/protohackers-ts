
export function tryPraseJSON(str: string): [any, unknown | null] {
  try {
    const parsed = JSON.parse(str)
    return [parsed, null]
  } catch (err) {
    return [null, err]
  }
}
