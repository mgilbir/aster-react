/**
 * LIVE differential for the NAME a transform is written with. vega looks a transform up by its lower-cased type, so
 * `Isocontour`, `FILTER` and `fIlTeR` are the transforms `isocontour`, `filter` and `filter`; a type it does not know (or
 * that is not text) is refused when the spec is parsed, with its own wording.
 *
 * Every transform vega can parse is written in several spellings, with the parameters of a case of the transform-case
 * list where there is one (none: bare), in a dataset and in a mark; real Vega and Aster must give the same rows, or the
 * same refusal, however it is spelled.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import '@aster-charts/core/transforms'
import '@aster-charts/core/geo'
import { CASES } from './transform-cases.mjs'
import { enc } from './differential-util.mts'

const HERE = dirname(fileURLToPath(import.meta.url))

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

// Rows are compared with `enc`: NaN, -0, undefined, +-Infinity and Dates stay apart (a JSON round trip would conflate them). The
// engine's rows hold no functions, and Vega's carry tuple ids (dropped here: they are Vega's identity, not a value).
const dropIds = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(dropIds)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v)) o[k] = dropIds((v as Record<string, unknown>)[k])
    return o
  }
  return v
}
const plain = (o: Outcome): unknown => enc(dropIds(o))
/** Aster's own refusals carry the `[aster] ` tag (docs/ERRORS.md); the wording after it is what is compared with Vega's. */
const untagged = (o: Outcome): Outcome => ('error' in o ? { error: o.error.replace(/^\[aster\] /, '') } : o)

/**
 * The only types whose lower-case spelling is not compared with Vega's, each with the reason and a check that the reason still
 * holds (so the list cannot outlive it). Every other type must agree with Vega in lower case, and then all four spellings are
 * compared with it in full.
 */
const NO_ORACLE: Record<string, { reason: string; holds: (vega: Outcome) => boolean }> = {
  heatmap: { reason: 'vega paints the grid into a canvas, and node has none', holds: (v) => 'error' in v && /reading 'getContext'/.test(v.error) },
  wordcloud: { reason: 'vega measures and places the words with a canvas, and node has none', holds: (v) => 'error' in v && /setting 'height'/.test(v.error) },
  geoshape: {
    reason: "vega's row holds a function (the path generator of the shape) where Aster's holds the path it draws; a function cannot be compared as a row, and the geoshape differentials compare the paths drawn",
    holds: (v) => 'rows' in v && Array.isArray(v.rows) && typeof (v.rows[0] as { shape?: unknown } | undefined)?.shape === 'function',
  },
}

const seen = { agreed: [] as string[], unlisted: [] as string[], noOracle: [] as string[] }
describe('a transform type is looked up in lower case (Aster vs real Vega)', { timeout: 60_000 }, () => {
  for (const name of NAMES) {
    it(`${name}: every spelling is the transform`, async () => {
      const c = sample(name)
      const base = c ? (c.t[0] as Record<string, unknown>) : { type: name }
      const rows = c ? c.rows : [{ a: 1 }]
      const extra = (c?.opt.extra ?? {}) as Record<string, unknown[]>
      const lower = dataSpec([base], rows, extra)
      const oracleLower = await vegaOutcome(lower)
      const asterLower = untagged(asterOutcome(lower))
      const listed = NO_ORACLE[name]
      if (listed) {
        expect(listed.holds(oracleLower), `${name}: ${listed.reason}, and it no longer does: remove it from NO_ORACLE`).toBe(true)
        seen.noOracle.push(name)
      } else {
        // the transform, in lower case, must be what Vega's is: the spellings are then compared with Vega in full
        expect(plain(asterLower), `${name} in lower case`).toEqual(plain(oracleLower))
        seen.agreed.push(name)
      }
      for (const spell of SPELLINGS) {
        const spec = dataSpec([withType(base, spell(name))], rows, extra)
        const oracle = await vegaOutcome(spec)
        const aster = untagged(asterOutcome(spec))
        if (!listed) expect(plain(aster), `${spell(name)}`).toEqual(plain(oracle))
        // whatever a transform does with its parameters, the spelling is not what it fails on
        expect(JSON.stringify(aster), `${spell(name)}`).not.toMatch(/unsupported transform|Unrecognized transform/)
        if (listed) expect(plain(aster), `${spell(name)} is the transform ${name}`).toEqual(plain(asterLower))
      }
    })
  }

  it('every transform Vega can parse was compared: all but the named ones agree with it in lower case', () => {
    expect(seen.agreed.length + seen.noOracle.length).toBe(NAMES.length)
    expect(seen.noOracle.sort()).toEqual(Object.keys(NO_ORACLE).sort())
    expect(seen.agreed.length).toBe(NAMES.length - Object.keys(NO_ORACLE).length)
  })

  it('a mark transform (label) is looked up the same way, and is the label transform of real Vega', () => {
    const mark = (type: string): Spec => ({
      width: 100, height: 100,
      data: [{ name: 'd', values: [{ a: 1, x: 5, y: 5 }, { a: 2, x: 6, y: 5 }, { a: 3, x: 80, y: 50 }] }],
      marks: [
        { type: 'symbol', name: 'base', from: { data: 'd' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { value: 200 } } } },
        { type: 'text', name: 'm', from: { data: 'base' }, encode: { update: { text: { field: 'datum.a' } } }, transform: [{ type, size: [100, 100], base: 'base' }] },
      ],
    })
    const labels = (spec: Spec): unknown =>
      JSON.parse(execFileSync(process.execPath, ['--import', join(HERE, '..', 'src', 'label-canvas', 'register.mjs'), join(HERE, '..', 'src', 'label-canvas', 'run-vega.mjs')], { input: JSON.stringify(spec), maxBuffer: 1 << 28 }).toString()).marks
        .find((m: { name: string }) => m.name === 'm').items.map((i: Record<string, unknown>) => ({ x: i.x, y: i.y, opacity: i.opacity, align: i.align, baseline: i.baseline }))
    const engine = (spec: Spec): unknown => {
      const scene = evaluateChart(compileChart(structuredClone(spec) as never), {}) as unknown as { items: unknown[] }
      const found: Array<{ name?: string; marktype?: string; items: Array<Record<string, unknown>> }> = []
      const visit = (n: { name?: string; marktype?: string; items?: unknown[] }): void => {
        if (n.marktype === 'text') found.push(n as never)
        for (const c of n.items ?? []) if (c && typeof c === 'object' && ((c as { marktype?: string }).marktype || (c as { items?: unknown }).items)) visit(c as never)
      }
      for (const g of scene.items) visit(g as never)
      return found.find((m) => m.name === 'm')!.items.map((i) => ({ x: i.x, y: i.y, opacity: i.opacity, align: i.align, baseline: i.baseline }))
    }
    const want = labels(mark('label'))
    expect(Array.isArray(want) && want.length, 'vega drew the labels').toBe(3)
    for (const spell of SPELLINGS) {
      const type = spell('label')
      expect(engine(mark(type)), type).toEqual(want)
      expect(labels(mark(type)), `vega itself reads ${type} as label`).toEqual(want)
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
