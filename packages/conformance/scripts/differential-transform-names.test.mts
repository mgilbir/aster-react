/**
 * LIVE differential for the NAME a transform is written with. vega looks a transform up by its lower-cased type, so
 * `Isocontour`, `FILTER` and `fIlTeR` are the transforms `isocontour`, `filter` and `filter`; a type it does not know (or
 * that is not text) is refused when the spec is parsed, with its own wording.
 *
 * Every transform vega can parse is written in several spellings, with the parameters of a case of the transform-case
 * list where there is one (none: bare), in a dataset and in a mark; real Vega and Aster must give the same rows, or the
 * same refusal, however it is spelled.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import '@aster-charts/core/transforms'
import '@aster-charts/core/geo'
import { CASES } from './transform-cases.mjs'

type Spec = Record<string, unknown>
type Outcome = { rows: unknown } | { error: string }

const registry = (vega as unknown as { transforms: Record<string, { Definition?: unknown }> }).transforms
const NAMES = Object.keys(registry).filter((k) => registry[k]!.Definition)

const SPELLINGS: Array<(n: string) => string> = [
  (n) => n,
  (n) => n.toUpperCase(),
  (n) => n[0]!.toUpperCase() + n.slice(1),
  (n) => [...n].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join(''),
]

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function vegaOutcome(spec: Spec, name = 'src'): Promise<Outcome> {
  vega.setRandom(vega.randomLCG(42))
  try {
    const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logLevel: vega.None })
    const errors: string[] = []
    view.logger({
      level() { return 1 },
      error(...a: unknown[]) { errors.push(a.map(message).join(' ').replace(/^Error: /, '')); return this },
      warn() { return this }, info() { return this }, debug() { return this },
    } as unknown as vega.LoggerInterface)
    try {
      await view.runAsync()
      if (errors.length) return { error: errors[0]! }
      return { rows: view.data(name) }
    } finally {
      view.finalize()
    }
  } catch (e) {
    return { error: message(e) }
  }
}

function asterOutcome(spec: Spec, name = 'src'): Outcome {
  try {
    const errors: string[] = []
    const logger = { error: (...a: unknown[]) => { errors.push(a.map(message).join(' ').replace(/^Error: /, '')) }, warn: () => {} }
    const scene = evaluateChart(compileChart(structuredClone(spec) as never), { logger, random: vega.randomLCG(42) })
    if (errors.length) return { error: errors[0]! }
    return { rows: datasetsOfScene(scene).get(name) ?? null }
  } catch (e) {
    return { error: message(e) }
  }
}

/** The data set `src`, transformed by `t`, with the data sets the transform-case list gives it. */
const dataSpec = (t: unknown[], rows: unknown[] = [{ a: 1 }], extra: Record<string, unknown[]> = {}): Spec => ({
  data: [...Object.entries(extra).map(([name, values]) => ({ name, values })), { name: 'src', values: rows, transform: t }],
})

const sample = (name: string) => CASES.find((c) => c.t.length === 1 && (c.t[0] as { type: string }).type === name)
const withType = (t: unknown, type: unknown): Record<string, unknown> => ({ ...(t as object), type })

// rows are compared by value; the engine's rows hold no functions, and Vega's carry tuple ids (dropped here)
const plain = (o: Outcome): unknown => JSON.parse(JSON.stringify(o, (k, v) => (k === 'Symbol(vega_id)' ? undefined : v)))

let agreedTypes = 0
describe('a transform type is looked up in lower case (Aster vs real Vega)', { timeout: 60_000 }, () => {
  for (const name of NAMES) {
    it(`${name}: every spelling is the transform`, async () => {
      const c = sample(name)
      const base = c ? (c.t[0] as Record<string, unknown>) : { type: name }
      const rows = c ? c.rows : [{ a: 1 }]
      const extra = (c?.opt.extra ?? {}) as Record<string, unknown[]>
      const lower = dataSpec([base], rows, extra)
      const [oracleLower, asterLower] = [plain(await vegaOutcome(lower)), plain(asterOutcome(lower))]
      // (a transform whose parameters Aster already treats as Vega does, spelled in lower case: the spelling is all that is left to compare)
      const agreed = JSON.stringify(oracleLower) === JSON.stringify(asterLower)
      agreedTypes += agreed ? 1 : 0
      for (const spell of SPELLINGS) {
        const spec = dataSpec([withType(base, spell(name))], rows, extra)
        const oracle = plain(await vegaOutcome(spec))
        const aster = plain(asterOutcome(spec))
        if (agreed) expect(aster, `${spell(name)}`).toEqual(oracle)
        // whatever the transform does with its parameters (a transform Aster does not run, say), the spelling is not what it fails on
        if (/unsupported transform/.test(JSON.stringify(asterLower))) expect(aster, `${spell(name)}`).toEqual(asterLower)
        else expect(JSON.stringify(aster), `${spell(name)}`).not.toMatch(/unsupported transform|Unrecognized transform/)
      }
    })
  }

  it('most transforms agree with Vega already when spelled in lower case, so the spellings are compared in full', () => {
    expect(agreedTypes).toBeGreaterThanOrEqual(20)
  })

  it('a mark transform (label) is looked up the same way', async () => {
    const mark = (type: string): Spec => ({
      width: 100, height: 100,
      data: [{ name: 'd', values: [{ a: 1 }] }],
      marks: [{ type: 'text', name: 'm', from: { data: 'd' }, encode: { update: { x: { value: 5 }, y: { value: 5 }, text: { value: 't' } } }, transform: [{ type, size: [100, 100] }] }],
    })
    for (const spell of SPELLINGS) {
      const type = spell('label')
      const a = asterOutcome(mark(type), 'd')
      expect(a, type).toEqual(asterOutcome(mark('label'), 'd'))
      expect('error' in a ? a.error : '').not.toMatch(/unsupported transform|Unrecognized transform/)
    }
  })

  describe('a type vega does not know', () => {
    const bad: unknown[] = ['foo', 'FOO', '', 'filter ', ' filter', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'compare', 'sieve', 'Params', undefined, null, 0, false, 5, true, {}, [], ['filter'], { toLowerCase: 1 }]
    for (const type of bad) {
      it(`refused as vega refuses it: ${JSON.stringify(type) ?? 'undefined'}`, async () => {
        const spec = dataSpec([{ type, expr: 'true' }])
        const oracle = await vegaOutcome(spec)
        expect('error' in oracle, 'vega refuses it').toBe(true)
        expect(asterOutcome(spec)).toEqual(oracle)
      })
    }
    it('in a mark, and in a group nested in a group', async () => {
      const spec: Spec = { marks: [{ type: 'group', marks: [{ type: 'group', transform: [{ type: 'Nope' }] }] }] }
      const oracle = await vegaOutcome(spec)
      expect('error' in oracle).toBe(true)
      expect(asterOutcome(spec)).toEqual(oracle)
    })
  })
})
