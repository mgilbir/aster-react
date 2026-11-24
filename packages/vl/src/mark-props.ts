/**
 * What vega-lite does with a mark-def property it reads only on some mark types (ignored-table.ts, generated from vega-lite by
 * scripts/ignored-table.mjs): per mark type, the properties it ignores on every chart, and those it writes as they are into the mark's
 * encoding (base.ts markDefProperties). Decoded once, on first use.
 */
import { MARKS, IGNORED, FORWARDED } from './ignored-table.js'

const NONE: ReadonlySet<string> = new Set()
let tables: { ignored: Map<string, ReadonlySet<string>>; forwarded: Map<string, readonly string[]> } | undefined

function decode(words: string, marks: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(marks.map((m) => [m, []]))
  for (const w of words.split(' ')) {
    const at = w.indexOf(':')
    const mask = parseInt(w.slice(at + 1), 36)
    marks.forEach((m, i) => {
      if (Math.floor(mask / 2 ** i) % 2 === 1) out.get(m)!.push(w.slice(0, at))
    })
  }
  return out
}

function load(): NonNullable<typeof tables> {
  if (tables === undefined) {
    const marks = MARKS.split(' ')
    const ignored = new Map<string, ReadonlySet<string>>()
    for (const [m, ps] of decode(IGNORED, marks)) ignored.set(m, new Set(ps))
    tables = { ignored, forwarded: decode(FORWARDED, marks) }
  }
  return tables
}

/** The mark-def properties vega-lite ignores on every chart of mark type `mark` (none for a type the table does not hold). */
export function ignoredMarkProps(mark: string): ReadonlySet<string> {
  return load().ignored.get(mark) ?? NONE
}

/** The mark-def properties vega-lite writes as they are into the encoding of mark type `mark`. */
export function forwardedMarkProps(mark: string): readonly string[] {
  return load().forwarded.get(mark) ?? []
}
