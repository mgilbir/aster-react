/**
 * What an encode entry that reads a scale the spec never declared throws. Vega compiles an entry to an expression that calls the
 * scale straight from the encoder's parameters: with no such scale the call is on `undefined`, the dataflow logs the error and
 * stops, and the item is left part-encoded (see `resolveEncodeSet`). Only the reads that call the scale fail: `{scale, band}` on
 * its own reads a bandwidth of 0, and `{scale}` alone is 0.
 */

/** The text of a dynamic scale reference as the failing call shows it: a signal is `_.$name`, a field of the datum `datum.name`. */
function dynamicRefText(ref: unknown): string {
  const r = ref as { signal?: unknown; datum?: unknown; group?: unknown; parent?: unknown }
  if (typeof r.signal === 'string') return /^[A-Za-z_$][\w$]*$/.test(r.signal) ? '_.$' + r.signal : r.signal
  if (typeof r.datum === 'string') return 'datum.' + r.datum
  if (typeof r.parent === 'string') return 'item.mark.group.datum.' + r.parent
  if (typeof r.group === 'string') return 'item.mark.group.' + r.group
  return 'datum'
}

/** The error of calling a scale (`{scale, field | value | signal}`) that does not exist; `ref` is the entry's `scale`. */
export function scaleCallFailure(ref: unknown): TypeError {
  return new TypeError(typeof ref === 'string' ? `_.%${ref} is not a function` : `_[("%" + ${dynamicRefText(ref)})] is not a function`)
}

/** The error of reading the range (`{scale, range}`) of a scale that does not exist. */
export function scaleRangeFailure(): TypeError {
  return new TypeError("Cannot read properties of undefined (reading 'range')")
}
