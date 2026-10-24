/**
 * Shared helpers of the live oracle differentials (`differential-*.test.mts`).
 *
 * Those tests run the pinned real Vega and Aster in the SAME process, on the same
 * inputs, and compare what both produce. Nothing is recorded: V8's Math.pow/exp/
 * log/sin/cos/atan2... are not bit-identical across Node versions, so numbers
 * recorded under one Node cannot gate another, and a tolerance would hide real
 * one-ulp divergences. Same engine on both sides removes the engine from the
 * comparison and keeps the equality exact.
 */

/**
 * Tagged, JSON-like image of a value: NaN, +-Infinity, -0, undefined, Dates, functions,
 * symbols and typed arrays survive `toEqual` (which would conflate several of them).
 * Object keys are sorted so the image does not depend on construction order.
 */
export function enc(v: unknown): unknown {
  if (v === undefined) return { $: 'undef' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (v === 0 && 1 / v < 0) return { $: '-0' }
    return v
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { $: 'baddate' } : { $: 'date', ms: v.getTime() }
  if (typeof v === 'function') return { $: 'fn' }
  if (typeof v === 'symbol') return { $: 'symbol', desc: v.description ?? null }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<unknown>, enc)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = enc((v as Record<string, unknown>)[k])
    return o
  }
  return v
}

/** `enc(f())`, or `{ $: 'throw' }` when `f` throws (both sides must refuse alike). */
export const attempt = (f: () => unknown): unknown => {
  try {
    return enc(f())
  } catch {
    return { $: 'throw' }
  }
}

/** A Vega logger that collects errors (the dataflow swallows operator errors; this surfaces them). */
export function quietLogger(errors: unknown[][]) {
  const q = {
    level() { return q },
    error(...a: unknown[]) { errors.push(a); return q },
    warn() { return q }, info() { return q }, debug() { return q },
  }
  return q
}

/** Run `fn` with `process.env.TZ` set (Node re-reads it), then restore it. */
export async function withTz<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}
