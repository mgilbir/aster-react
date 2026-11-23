/**
 * The value codec of the recorded oracle vectors (gen-vectors.mjs writes them, packages/core/src/oracle-vectors.test.ts
 * replays them with a mirror of this codec; the two must agree).
 *
 * JSON cannot express NaN, Infinity, -0, undefined, Dates, RegExps or Symbols, so those values are tagged. A Date's time is
 * itself encoded: an invalid Date has the time NaN, which JSON would write as null (and `new Date(null)` is the epoch).
 */

/** A value -> its JSON-safe tagged form. */
export function enc(v) {
  if (v === undefined) return { $: 'undef' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (v === 0 && 1 / v < 0) return { $: '-0' }
    return v
  }
  if (v instanceof Date) return { $: 'date', ms: enc(v.getTime()) }
  if (v instanceof RegExp) return { $: 're', src: v.source, flags: v.flags }
  if (typeof v === 'symbol') return { $: 'symbol', desc: v.description ?? null }
  if (v instanceof Int8Array) return { $: 'int8array' }
  if (typeof v === 'function') return { $: 'fn' }
  if (Array.isArray(v)) return v.map(enc)
  if (v !== null && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = enc(v[k])
    return o
  }
  return v
}

/** A tagged form -> the value it stands for. */
export function dec(v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(dec)
  switch (v.$) {
    case 'undef': return undefined
    case 'nan': return NaN
    case 'inf': return Infinity
    case '-inf': return -Infinity
    case '-0': return -0
    case 'date': return new Date(dec(v.ms))
    case 're': return new RegExp(v.src, v.flags)
    case 'symbol': return Symbol(v.desc ?? undefined)
    case 'int8array': return new Int8Array(1)
    case 'fn': return () => 1
    default: {
      const o = {}
      for (const [k, val] of Object.entries(v)) o[k] = dec(val)
      return o
    }
  }
}
