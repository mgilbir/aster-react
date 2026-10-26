/**
 * LIVE differential for Vega-Lite's selection functions (vega-selections): `vlSelectionTest`, `vlSelectionIdTest`,
 * `vlSelectionResolve` and `vlSelectionTuples` evaluated by real vega and by Aster (same process, same engine) over
 * seeded random selection stores must return the same values. A store is the dataset of tuples a selection writes:
 * intentional ones ({unit, fields, values}: enumerated values, ranges, bins and predicates) and extensional ones
 * ({unit, _vgsid_}), over one or several units, tested with every set operation.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '../../core/src/index.ts'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIELD_TYPES = ['E', 'R', 'R-E', 'R-LE', 'R-RE', 'E-LT', 'E-LTE', 'E-GT', 'E-GTE', 'E-VALID', 'E-ONE'] as const
const OPS = [undefined, 'union', 'intersect'] as const

type Json = unknown

function genStore(r: () => number, extensional: boolean): Json[] {
  const units = ['unit_a', 'unit_b', 'unit_c'].slice(0, 1 + Math.floor(r() * 3))
  const n = 1 + Math.floor(r() * 5)
  const out: Json[] = []
  if (extensional) {
    // the ids are sorted: vlSelectionIdTest bisects
    const ids = [...new Set(Array.from({ length: n * 2 }, () => Math.floor(r() * 12)))].sort((a, b) => a - b)
    for (const id of ids) out.push({ unit: units[Math.floor(r() * units.length)], _vgsid_: id })
    return out.sort((a, b) => ((a as { _vgsid_: number })._vgsid_ - (b as { _vgsid_: number })._vgsid_))
  }
  for (let i = 0; i < n; i++) {
    const nf = 1 + Math.floor(r() * 2)
    const fields: Json[] = []
    const values: Json[] = []
    for (let j = 0; j < nf; j++) {
      const type = FIELD_TYPES[Math.floor(r() * FIELD_TYPES.length)]!
      const field = ['a', 'b', 'c'][j]!
      fields.push({ field, type, channel: 'x' })
      const lo = Math.floor(r() * 8)
      const hi = lo + Math.floor(r() * 6)
      values.push(
        type === 'E' ? (r() < 0.5 ? Math.floor(r() * 8) : [Math.floor(r() * 8), Math.floor(r() * 8)])
          : type.startsWith('R') ? [r() < 0.2 ? hi : lo, r() < 0.2 ? lo : hi]
            : type === 'E-VALID' ? true
              : type === 'E-ONE' ? [Math.floor(r() * 8), Math.floor(r() * 8), 3]
                : Math.floor(r() * 8),
      )
    }
    out.push({ unit: units[Math.floor(r() * units.length)], fields, values })
  }
  return out
}

function genDatum(r: () => number): Json {
  const v = (): Json => (r() < 0.08 ? null : Math.floor(r() * 10))
  return { a: v(), b: v(), c: v(), _vgsid_: Math.floor(r() * 12) }
}

/** What both engines are asked: one signal per call, each with its own literal arguments. */
function genSpec(seed: number): { spec: Record<string, unknown>; names: string[] } {
  const r = rng(seed)
  const signals: Array<Record<string, unknown>> = []
  const datasets: Array<Record<string, unknown>> = []
  for (let s = 0; s < 3; s++) {
    const extensional = s === 2
    datasets.push({ name: `store${s}`, values: genStore(r, extensional) })
    for (let k = 0; k < 8; k++) {
      const op = OPS[Math.floor(r() * OPS.length)]
      const opArg = op === undefined ? '' : `, ${JSON.stringify(op)}`
      signals.push({ name: `test_${s}_${k}`, update: `${extensional ? 'vlSelectionIdTest' : 'vlSelectionTest'}("store${s}", ${JSON.stringify(genDatum(r))}${opArg})` })
    }
    if (!extensional) {
      for (const op of OPS) {
        for (const isMulti of [true, false]) {
          for (const vl5 of [true, false]) {
            const name = `resolve_${s}_${op ?? 'none'}_${isMulti}_${vl5}`
            signals.push({ name, update: `vlSelectionResolve("store${s}", ${JSON.stringify(op ?? null)}, ${isMulti}, ${vl5})` })
          }
        }
      }
    } else {
      for (const op of OPS) signals.push({ name: `resolve_${s}_${op ?? 'none'}`, update: `vlSelectionResolve("store${s}", ${JSON.stringify(op ?? null)}, true, true)` })
    }
  }
  // tuples: scene items -> store entries, with and without projected fields
  const items = Array.from({ length: 3 }, () => ({ datum: genDatum(r) }))
  signals.push({ name: 'tuples_fields', update: `vlSelectionTuples(${JSON.stringify(items)}, {"unit": "u", "fields": [{"field": "a", "type": "E"}, {"field": "b", "type": "R"}]})` })
  signals.push({ name: 'tuples_ids', update: `vlSelectionTuples(${JSON.stringify(items)}, {"unit": "u"})` })
  return {
    spec: { width: 10, height: 10, data: datasets, signals, marks: [] },
    names: signals.map((s) => s.name as string),
  }
}

/** Sets become sorted arrays, so engine-specific container types compare by content. */
const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Set ? { __set: [...x].sort() } : x === undefined ? '__undefined__' : x)))

/**
 * Real vega unions into the value lists of the store's own tuples, so a `vlSelectionResolve` leaves its store changed for the
 * next call (Aster's does not: a call is a function of the store). Each resolve therefore gets a fresh view; the pure
 * tests share one.
 */
async function viaVega(spec: Record<string, unknown>, names: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const run = async (signalNames: string[]): Promise<void> => {
    const subset = { ...spec, signals: (spec.signals as Array<{ name: string }>).filter((s) => signalNames.includes(s.name)) }
    const view = new vega.View(vega.parse(structuredClone(subset) as vega.Spec), { renderer: 'none', logLevel: vega.None })
    await view.runAsync()
    for (const n of signalNames) out[n] = norm(view.signal(n))
    view.finalize()
  }
  await run(names.filter((n) => !n.startsWith('resolve_')))
  for (const n of names.filter((n) => n.startsWith('resolve_'))) await run([n])
  return out
}

function viaAster(spec: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const scene = evaluateChart(compileChart(structuredClone(spec) as never)) as unknown as { signalParams: Record<string, unknown> }
  const out: Record<string, unknown> = {}
  for (const n of names) out[n] = norm(scene.signalParams[n])
  return out
}

describe(`vega-selections functions vs vega@${vega.version} (live)`, () => {
  for (let k = 0; k < 40; k++) {
    const seed = 1100 + k * 17
    it(`seed ${seed}`, async () => {
      const { spec, names } = genSpec(seed)
      const want = await viaVega(spec, names)
      expect(viaAster(spec, names)).toEqual(want)
    })
  }

  it('the stores exercise both outcomes (a vacuous comparison would prove nothing)', async () => {
    const tally = { t: 0, f: 0, resolved: 0 }
    for (let k = 0; k < 40; k++) {
      const { spec, names } = genSpec(1100 + k * 17)
      const got = await viaVega(spec, names)
      for (const n of names) {
        if (n.startsWith('test_')) got[n] === true ? tally.t++ : tally.f++
        else if (n.startsWith('resolve_') && JSON.stringify(got[n]) !== '{}') tally.resolved++
      }
    }
    expect(tally.t).toBeGreaterThan(50)
    expect(tally.f).toBeGreaterThan(50)
    expect(tally.resolved).toBeGreaterThan(100)
  })
})
