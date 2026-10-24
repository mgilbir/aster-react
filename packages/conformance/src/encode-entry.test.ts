/**
 * Encode entries against the real vega-parser (audit C54).
 *
 * vega-parser's encode/entry.js builds the channel's expression as concatenated TEXT:
 *   value = (signal) | field | value;  scale(...);  pow(value, e);  *mult;  +offset;  round(value)
 * so `s*mult + offset` (never offset first), and with a `band` the text is
 * `_scale(..)+_bandwidth(..)*band` -- a trailing `*mult` binds to the bandwidth term only.
 * `mult`/`offset`/`exponent`/`band` may themselves be entries ({signal}, {field}, {scale,...}),
 * and `round`, `range` and `extra` are part of the grammar.
 *
 * Every combination below is rendered by real vega and by @aster/core and judged by the
 * strict canonicalizer; the entries are placed on a rect's `x`, so a wrong number is a wrong
 * path. The test is also required to see numbers MOVE with each modifier (a case where every
 * modifier were silently ignored would still "agree" with an engine that ignores them).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none' },
  )
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const specFor = (x: Record<string, unknown>): Spec => ({
  width: 200, height: 60, padding: 5, autosize: 'none',
  signals: [{ name: 'sm', value: 3 }, { name: 'so', value: -4 }, { name: 'se', value: 1.5 }, { name: 'sb', value: 0.25 }],
  data: [{ name: 't', values: [{ k: 'a', v: 1, w: 2.4 }, { k: 'b', v: 4, w: 7.5 }, { k: 'c', v: 9, w: 10 }] }],
  scales: [
    { name: 'lx', type: 'linear', domain: [0, 10], range: 'width' },
    { name: 'bx', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.2 },
    { name: 'px', type: 'pow', exponent: 2, domain: [0, 10], range: 'width' },
    { name: 'off', type: 'linear', domain: [0, 10], range: [0, 20] },
  ],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x, y: { value: 10 }, width: { value: 5 }, height: { value: 5 }, fill: { value: '#4c78a8' } } } }],
})

const BASES: Array<[string, Record<string, unknown>]> = [
  ['field', { field: 'v' }],
  ['value', { value: 3 }],
  ['signal', { signal: 'datum.v * 2 + 1' }],
  ['group-width', { field: { group: 'width' } }],
  ['scale-field', { scale: 'lx', field: 'v' }],
  ['scale-value', { scale: 'lx', value: 5 }],
  ['pow-scale', { scale: 'px', field: 'w' }],
  ['band-field', { scale: 'bx', field: 'k' }],
  ['band-1', { scale: 'bx', field: 'k', band: 1 }],
  ['band-half', { scale: 'bx', field: 'k', band: 0.5 }],
  ['band-true', { scale: 'bx', field: 'k', band: true }],
  ['band-signal', { scale: 'bx', field: 'k', band: { signal: 'sb' } }],
  ['band-only', { scale: 'bx', band: 1 }],
  ['band-only-quarter', { scale: 'bx', band: 0.25 }],
  ['band-extra', { scale: 'bx', field: 'k', band: 1, extra: true }],
  ['range-half', { scale: 'lx', range: 0.5 }],
  ['range-one', { scale: 'bx', range: 1 }],
  ['scale-signal-name', { scale: { signal: '"lx"' }, field: 'v' }],
]

const MODS: Array<[string, Record<string, unknown>]> = [
  ['none', {}],
  ['mult', { mult: 2 }],
  ['offset', { offset: 10 }],
  ['mult+offset', { mult: 2, offset: 10 }],
  ['neg-mult+offset', { mult: -0.5, offset: 7 }],
  ['mult-signal+offset-signal', { mult: { signal: 'sm' }, offset: { signal: 'so' } }],
  ['mult-field', { mult: { field: 'v' } }],
  ['offset-scale', { offset: { scale: 'off', field: 'v' } }],
  ['exponent', { exponent: 2 }],
  ['exponent-signal', { exponent: { signal: 'se' } }],
  ['exponent+mult+offset', { exponent: 2, mult: 0.5, offset: 3 }],
  ['round', { round: true }],
  ['round+mult', { round: true, mult: 1.37 }],
  ['round+mult+offset+exponent', { round: true, mult: 1.1, offset: 0.4, exponent: 2 }],
]

describe('encode entries match vega-parser entry.js', () => {
  const cases = BASES.flatMap(([bn, base]) => MODS.map(([mn, mod]) => [`${bn} ${mn}`, { ...base, ...mod }] as const))
  it('covers every base x modifier combination', () => {
    expect(cases.length).toBe(BASES.length * MODS.length)
    expect(cases.length).toBeGreaterThan(200)
  })
  it.each(cases)('%s', async (_name, entry) => {
    const spec = specFor(entry)
    const diffs = diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))
    expect(diffs).toEqual([])
  })

  it('the modifiers visibly change the output (a vacuous comparison would pass anything)', async () => {
    const svgOf = async (x: Record<string, unknown>): Promise<string> => canonicalizeSvg(await oracleSvg(specFor(x))) as unknown as string
    const plain = JSON.stringify(await svgOf({ scale: 'px', field: 'w' }))
    for (const [, mod] of MODS.slice(1)) {
      expect(JSON.stringify(await svgOf({ scale: 'px', field: 'w', ...mod })), JSON.stringify(mod)).not.toBe(plain)
    }
  })

  it('mult comes before offset: {mult: 2, offset: 10} on a constant 5 is 20, not 30', () => {
    const svg = renderSpec(specFor({ value: 5, mult: 2, offset: 10 }) as never)
    // x = 20 (+ the 5px padding translate lives outside the path)
    expect(svg).toContain('M20,10h5')
  })
})
