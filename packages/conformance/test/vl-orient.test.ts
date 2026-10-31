// @vitest-environment node
/**
 * Which way a mark runs (`orientationOf`), against vega-lite 6.4.3, over mark x what each position channel is x whether x2 / y2 are
 * encoded x the orient asked for.
 *
 * vega-lite does not print the orientation it settles on, but it warns when it overrides the one that was asked for: `Specified orient
 * "<settled>" overridden with "<asked>"`. Asking for each orientation in turn therefore gives the answer for both, exactly; and when
 * either is overridden, the orientation does not depend on what was asked, which gives the answer for no orient asked as well. (When
 * both are honoured, vega-lite's answer for none asked is not visible, and only the two asked answers are compared.)
 *
 * The `Position` of each kind of channel is what the compiler reads of the field definition it makes of it (compile.ts markOrient).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { orientationOf, type Position } from '../../vl/src/orient.js'

const pos = (p: Partial<Position> = {}): Position => ({ present: true, field: false, aggregate: false, prebinned: false, measure: false, temporal: false, ...p })

interface Kind { def?: Record<string, unknown>; position: Position }
const KINDS: Record<string, Kind> = {
  none: { position: pos({ present: false }) },
  q: { def: { field: 'q', type: 'quantitative' }, position: pos({ field: true, measure: true }) },
  qagg: { def: { field: 'q', type: 'quantitative', aggregate: 'sum' }, position: pos({ field: true, aggregate: true, measure: true }) },
  count: { def: { aggregate: 'count', type: 'quantitative' }, position: pos({ field: true, aggregate: true, measure: true }) },
  n: { def: { field: 'n', type: 'nominal' }, position: pos({ field: true }) },
  nagg: { def: { field: 'n', type: 'nominal', aggregate: 'distinct' }, position: pos({ field: true, aggregate: true, measure: true }) },
  o: { def: { field: 'o', type: 'ordinal' }, position: pos({ field: true }) },
  t: { def: { field: 't', type: 'temporal' }, position: pos({ field: true, temporal: true }) },
  tu: { def: { field: 't', type: 'temporal', timeUnit: 'month' }, position: pos({ field: true, temporal: true }) },
  qbin: { def: { field: 'q', type: 'quantitative', bin: true }, position: pos({ field: true }) },
  prebinned: { def: { field: 'b0', type: 'quantitative', bin: 'binned' }, position: pos({ field: true, prebinned: true }) },
  value: { def: { value: 3 }, position: pos() },
  // (a datum is not a field: it is a measure when it is a number)
  datumNumber: { def: { datum: 3 }, position: pos({ measure: true }) },
  datumString: { def: { datum: 'a' }, position: pos() },
}
/** x2 / y2 */
const SECOND: Record<string, Record<string, unknown> | undefined> = { none: undefined, field: { field: 'q2', type: 'quantitative' }, value: { value: 3 } }
/** The marks that have an orientation to decide (vega-lite makes a ranged line a rule before it asks, so a line has no second channel). */
const MARKS = ['bar', 'text', 'rule', 'area', 'line', 'tick']
/** The marks that have none: Aster calls their orientation vertical, whatever they are given. */
const FIXED = ['trail', 'point', 'circle', 'square', 'rect', 'arc', 'image', 'geoshape']

const DATA = Array.from({ length: 12 }, (_, i) => ({ q: i, q2: i + 2, n: 'ABC'[i % 3], o: i % 4, t: `2020-0${1 + (i % 9)}-01`, b0: i, b1: i + 1 }))

/** What vega-lite settles on when `asked` is asked for: the orientation, `null` when it has none, `'refused'` when it will not compile. */
function settled(mark: string, encoding: Record<string, unknown>, asked: string): string | null | 'refused' {
  const warnings: string[] = []
  const logger: any = { level: () => logger, warn: (m: string) => { warnings.push(String(m)); return logger }, info: () => logger, debug: () => logger, error: () => logger }
  try { (vl as any).compile({ data: { values: DATA }, mark: { type: mark, orient: asked }, encoding }, { logger }) } catch { return 'refused' }
  const overridden = warnings.map((w) => /^Specified orient "(.*)" overridden with "(.*)"\.$/.exec(w)).find((m) => m !== null)
  if (!overridden) return asked
  return overridden[1] === 'undefined' ? null : overridden[1]!
}

let compared = 0
let natural = 0
const mismatches: string[] = []
const check = (got: string | null, want: string | null, label: string): void => { if (got !== want) mismatches.push(`${label}: aster ${got}, vega-lite ${want}`) }
for (const mark of MARKS) {
  describe(`${mark}`, () => {
    for (const [xName, x] of Object.entries(KINDS)) {
      it(`x ${xName}`, () => {
        for (const [yName, y] of Object.entries(KINDS)) {
          for (const [x2Name, x2] of Object.entries(SECOND)) {
            for (const [y2Name, y2] of Object.entries(SECOND)) {
              if (x.def === undefined && x2 !== undefined) continue
              if (mark === 'line' && (x2 !== undefined || y2 !== undefined)) continue
              if (y.def === undefined && y2 !== undefined) continue
              const encoding: Record<string, unknown> = {}
              if (x.def) encoding.x = x.def
              if (y.def) encoding.y = y.def
              if (x2) encoding.x2 = x2
              if (y2) encoding.y2 = y2
              if (Object.keys(encoding).length === 0) continue
              const vertical = settled(mark, encoding, 'vertical')
              const horizontal = settled(mark, encoding, 'horizontal')
              if (vertical === 'refused' || horizontal === 'refused') continue
              const input = { x: x.position, y: y.position, x2: x2 !== undefined, y2: y2 !== undefined }
              const label = `${mark} x=${xName} y=${yName} x2=${x2Name} y2=${y2Name}`
              check(orientationOf(mark, { ...input, asked: 'vertical' }) ?? null, vertical, `${label}, vertical asked`)
              check(orientationOf(mark, { ...input, asked: 'horizontal' }) ?? null, horizontal, `${label}, horizontal asked`)
              compared++
              // (an orientation that does not follow what was asked for is the encoding's own)
              if (vertical !== 'vertical' || horizontal !== 'horizontal') {
                check(orientationOf(mark, { ...input, asked: undefined }) ?? null, vertical !== 'vertical' ? vertical : horizontal, `${label}, none asked`)
                natural++
              }
            }
          }
        }
      })
    }
  })
}

describe('the space was covered', () => {
  it('agrees with vega-lite everywhere', () => {
    expect(mismatches).toEqual([])
  })
  it('compared a good part of it', () => {
    expect(compared).toBeGreaterThan(5000)
    expect(natural).toBeGreaterThan(1000)
  })
})

describe('a mark with no orientation is vertical', () => {
  for (const mark of FIXED) {
    it(mark, () => {
      for (const asked of [undefined, 'vertical', 'horizontal']) {
        for (const x of Object.values(KINDS)) {
          for (const y of Object.values(KINDS)) expect(orientationOf(mark, { x: x.position, y: y.position, x2: true, y2: true, asked })).toBe('vertical')
        }
      }
    })
  }
})

// --- what the compiler makes of the channels --------------------------------------------------------------------------------------

/** What the compiled mark says of the way it runs: the properties its encoding sets along each axis. */
const probe = (spec: any): unknown =>
  (function flat(ms: any[]): any[] { return (ms ?? []).flatMap((m: any) => (m.type === 'group' ? flat(m.marks) : [m])) })(spec.marks).map((m: any) => ({
    type: m.type,
    keys: Object.keys(m.encode?.update ?? {}).filter((k) => /^(x|x2|xc|y|y2|yc|width|height)$/.test(k)).sort(),
  }))

/**
 * The orientation vega-lite settles on by itself, as the marks show it: pairs of position channels in which exactly one is a measure,
 * or both are, or exactly one of two is temporal. (The marks of a pair in which it settles on none are compiled in their own ways.)
 */
describe('the orientation the compiled marks show', () => {
  const NATURAL: Record<string, Record<string, unknown> | undefined> = {
    none: undefined,
    q: { field: 'q', type: 'quantitative' },
    qagg: { field: 'q', type: 'quantitative', aggregate: 'sum' },
    n: { field: 'n', type: 'nominal' },
    o: { field: 'o', type: 'ordinal' },
    t: { field: 't', type: 'temporal' },
    qbin: { field: 'q', type: 'quantitative', bin: true },
  }
  const measure = (k: string) => k === 'q' || k === 'qagg'
  const settles = (x: string, y: string) => measure(x) !== measure(y) || (measure(x) && measure(y)) || (x !== 'none' && y !== 'none' && (x === 't') !== (y === 't'))
  for (const mark of ['line', 'tick', 'area', 'bar', 'rule']) {
    it(mark, async () => {
      const { compile } = await import('@aster/vl')
      const different: string[] = []
      let looked = 0
      for (const [xName, x] of Object.entries(NATURAL)) {
        for (const [yName, y] of Object.entries(NATURAL)) {
          if ((x === undefined && y === undefined) || !settles(xName, yName)) continue
          if (mark === 'rule' && (xName === 'qbin' || yName === 'qbin')) continue
          const spec = { data: { values: DATA }, mark, encoding: { ...(x ? { x } : {}), ...(y ? { y } : {}) } }
          const ours = probe(compile(JSON.parse(JSON.stringify(spec))))
          const theirs = probe((vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: { level: () => null, warn() {}, info() {}, debug() {}, error() {} } }).spec)
          looked++
          if (JSON.stringify(ours) !== JSON.stringify(theirs)) different.push(`x=${xName} y=${yName}`)
        }
      }
      expect(different).toEqual([])
      expect(looked).toBeGreaterThan(10)
    })
  }
})

describe('the compiler reads the channels as the table does', () => {
  const bar = (x: unknown, y: unknown) => ({ mark: 'bar', encoding: { x, y } })
  const aggregated = { field: 'q', type: 'quantitative', aggregate: 'sum' }
  const nominal = { field: 'n', type: 'nominal' }
  const prebinned = (field: string) => ({ field, type: 'quantitative', bin: 'binned' })
  const q2 = { field: 'q2', type: 'quantitative' }
  const CASES: Array<[string, Record<string, unknown>]> = [
    ['an aggregate against a numeric datum', bar(aggregated, { datum: 3 })],
    ['a numeric datum against an aggregate', bar({ datum: 3 }, aggregated)],
    ['an aggregate against a string datum', bar(aggregated, { datum: 'a' })],
    ['a nominal against a numeric datum', bar(nominal, { datum: 3 })],
    ['a numeric datum against a nominal', bar({ datum: 3 }, nominal)],
    ['an area over a pre-binned y with y2', { mark: 'area', encoding: { x: { field: 'q', type: 'quantitative' }, y: prebinned('b0'), y2: { field: 'b1', type: 'quantitative' } } }],
    ['an area over a pre-binned x with x2', { mark: 'area', encoding: { y: { field: 'q', type: 'quantitative' }, x: prebinned('b0'), x2: { field: 'b1', type: 'quantitative' } } }],
    ['a rule between two measures on both axes', { mark: 'rule', encoding: { x: { field: 'q', type: 'quantitative' }, x2: q2, y: { field: 'q', type: 'quantitative' }, y2: q2 } }],
  ]
  for (const [name, mk] of CASES) {
    it(name, async () => {
      const { compile } = await import('@aster/vl')
      const spec = { data: { values: DATA }, ...mk }
      const ours = compile(JSON.parse(JSON.stringify(spec)))
      const theirs = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: { level: () => null, warn() {}, info() {}, debug() {}, error() {} } }).spec
      expect(probe(ours)).toEqual(probe(theirs))
    })
  }
})
