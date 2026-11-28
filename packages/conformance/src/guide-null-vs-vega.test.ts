// @vitest-environment jsdom
/**
 * `null` in every property of every guide, against real Vega.
 *
 * What a guide property does is decided by vega-parser's guide encoders, property by property (parsers/guides/*.js,
 * parsers/title.js): the spec's value, else the config's, else nothing -- a `null` in the SPEC is no value (the config's
 * then applies), a `null` in the CONFIG removes the default (the channel is absent and the style default applies), and a
 * `null` that comes out of a SIGNAL is a value: it reaches the item's channel as null (a size of null is the text mark's
 * own 11, a tick size of null is no tick, a padding of null is none). This suite walks every property of the Vega schema's
 * axis, legend and title definitions through the three ways to say null, on every kind of guide, and lets the oracle
 * decide. The property lists are read from the schema, so a property vega adds is covered the day the schema is bumped.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { expectKnownDifference } from './known-differences.js'
import schema from '../node_modules/vega/build/vega-schema.json' with { type: 'json' }

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const log = console.error
  console.error = () => {}
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    console.error = log
    view.finalize()
  }
}

/**
 * The one class of spec `vega.parse` refuses here: a config that nulls a layout parameter of the legend (`config.legend.gridAlign`,
 * `rowPadding`, `columnPadding` or `gradientLength` = null) makes the parser write `undefined` into an expression of the entry layout,
 * and it throws `Unrecognized signal name: "undefined"` (docs/ERRORS.md says the layout is written out and parsed as vega writes it:
 * with these nulls vega's own parser breaks, and Aster renders -- a case of the expected-differences table, held on its own probe
 * below). Every refusal is judged where it happens: it must be of this class and Aster must render the spec, so nothing is counted
 * for later, and a refusal of any other spec, or of this one with another message, fails the walk that met it.
 */
const REFUSED_LEGEND_LAYOUT = new Set(['gridAlign', 'rowPadding', 'columnPadding', 'gradientLength'])
const REFUSAL = 'Unrecognized signal name: "undefined"'
const refusedClass = (spec: Spec): boolean => {
  const legend = (spec.config as { legend?: Record<string, unknown> } | undefined)?.legend
  return legend !== undefined && Object.entries(legend).some(([k, v]) => REFUSED_LEGEND_LAYOUT.has(k) && v === null)
}
/** How many specs of the walks vega refused (a counter the legend walks read before and after). */
const metRefusals = { n: 0 }

async function compare(spec: Spec, what: string): Promise<string[]> {
  let want: string
  try {
    want = await oracleSvg(spec)
  } catch (e) {
    const message = (e as Error).message.split('\n')[0]!
    // (vega refuses: Aster is run on the same spec, and what it does is asserted, not skipped)
    if (!refusedClass(spec) || message !== REFUSAL) return [`${what}: vega refused an unexpected spec: ${message}`]
    let rendered: string
    try { rendered = renderSpec(structuredClone(spec) as never) } catch (err) { return [`${what}: vega refuses, Aster threw: ${(err as Error).message}`] }
    try { canonicalizeSvg(rendered) } catch (err) { return [`${what}: vega refuses, Aster's document is unreadable: ${(err as Error).message}`] }
    metRefusals.n++
    return []
  }
  return diffCanonical(canonicalizeSvg(want), canonicalizeSvg(renderSpec(spec as never)))
}

type Def = { properties?: Record<string, unknown>; allOf?: Def[]; oneOf?: Def[]; anyOf?: Def[] }
const definitions = (schema as unknown as { definitions: Record<string, Def> }).definitions
/** the property names of a schema definition, through its allOf / oneOf / anyOf branches */
function collect(def: Def | undefined, into = new Set<string>()): Set<string> {
  if (!def) return into
  for (const k of Object.keys(def.properties ?? {})) into.add(k)
  for (const branch of [...(def.allOf ?? []), ...(def.oneOf ?? []), ...(def.anyOf ?? [])]) collect(branch, into)
  return into
}
const propsOf = (name: string): string[] => [...collect(definitions[name])]

const ROWS = [{ k: 'a', v: 28 }, { k: 'b', v: 55 }, { k: 'c', v: 43 }, { k: 'd', v: 91 }]
const frame = (extra: Spec): Spec => ({ width: 200, height: 120, padding: 5, autosize: 'none', data: [{ name: 't', values: ROWS }], ...extra })
const withNull = (spec: Spec): Spec => ({ ...spec, signals: [...((spec.signals as Spec[] | undefined) ?? []), { name: 'nothing', value: null }] })

/** the three ways to say null for property `p` of a guide (given by `put`, which writes it into a spec) */
function variants(p: string, put: (spec: Spec, value: unknown) => Spec, config: (spec: Spec, value: unknown) => Spec, make: () => Spec): Array<[string, Spec]> {
  return [
    [`${p} = {signal: null}`, put(withNull(make()), { signal: 'nothing' })],
    [`${p} = null`, put(make(), null)],
    [`config ${p} = null`, config(make(), null)],
  ]
}

describe('null in every property of an axis', () => {
  // the keys that are not properties of how the axis looks: the scales it names (a null one is a TypeError in the axis's
  // encode, which aborts vega's dataflow: see axis-ticks-failure-vs-vega.test.ts), its orientation (a missing one is a
  // TypeError in vega-parser's axis config) and the encode blocks
  const structural = new Set(['scale', 'gridScale', 'orient', 'encode'])
  const kinds: Array<[string, () => Spec]> = [
    ['a bottom axis over a band scale, every mark on', () => frame({
      scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 }],
      axes: [{ orient: 'bottom', scale: 'x', title: 'Title', grid: true }], marks: [],
    })],
    ['a left axis over a linear scale, every mark on', () => frame({
      scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
      axes: [{ orient: 'left', scale: 'y', title: 'Title', grid: true, tickCount: 4 }], marks: [],
    })],
    ['a top axis over a time scale', () => frame({
      scales: [{ name: 't', type: 'time', domain: [1e12, 1.01e12], range: 'width' }],
      axes: [{ orient: 'top', scale: 't', title: 'Title', labelOverlap: true }], marks: [],
    })],
  ]
  const props = propsOf('axis').filter((p) => !structural.has(p))
  for (const [kind, make] of kinds) {
    it(`${props.length} properties x three nulls, on ${kind}`, async () => {
      const bad: string[] = []
      for (const p of props) {
        const put = (spec: Spec, v: unknown): Spec => ({ ...spec, axes: [{ ...(spec.axes as Spec[])[0]!, [p]: v }] })
        const cfg = (spec: Spec, v: unknown): Spec => ({ ...spec, config: { axis: { [p]: v } } })
        for (const [what, spec] of variants(p, put, cfg, make)) {
          const d = await compare(spec, `${kind}: ${what}`)
          if (d.length) bad.push(`${what}: ${d[0]}`)
        }
      }
      expect(bad).toEqual([])
    }, 300_000)
  }
})

describe('null in every property of a legend', () => {
  // How many of the nulled config properties vega.parse refuses on each kind (the layout parameters the kind reads): exact, so a walk
  // that did not run, or a refusal that moved, is seen. 11 of the 1983 cases of this file.
  const REFUSED_ON: Record<string, number> = {
    'a symbol legend': 3, 'a symbol legend on the left, in columns': 3, 'a gradient legend': 1, 'a horizontal gradient legend': 1,
    'a discrete legend (quantize)': 0, 'a size legend': 3,
  }
  // the keys that name the scales a legend maps, and its encode blocks
  // (a legend's `type` is a plain enum in the schema: no signal)
  const structural = new Set(['fill', 'stroke', 'size', 'shape', 'opacity', 'strokeDash', 'strokeWidth', 'type', 'encode'])
  const colour = { name: 'c', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' }
  const kinds: Array<[string, () => Spec]> = [
    ['a symbol legend', () => frame({ scales: [colour], legends: [{ fill: 'c', title: 'Title' }], marks: [] })],
    ['a symbol legend on the left, in columns', () => frame({ scales: [colour], legends: [{ fill: 'c', title: 'Title', orient: 'left', columns: 2 }], marks: [] })],
    ['a gradient legend', () => frame({
      scales: [{ name: 'g', type: 'linear', domain: [0, 100], range: ['white', 'black'] }], legends: [{ fill: 'g', title: 'Title' }], marks: [],
    })],
    ['a horizontal gradient legend', () => frame({
      scales: [{ name: 'g', type: 'linear', domain: [0, 100], range: ['white', 'black'] }],
      legends: [{ fill: 'g', title: 'Title', orient: 'bottom', direction: 'horizontal' }], marks: [],
    })],
    ['a discrete legend (quantize)', () => frame({
      scales: [{ name: 'q', type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] }], legends: [{ fill: 'q', title: 'Title' }], marks: [],
    })],
    ['a size legend', () => frame({
      scales: [{ name: 's', type: 'linear', domain: [0, 100], range: [10, 400] }], legends: [{ size: 's', title: 'Title' }], marks: [],
    })],
  ]
  const props = propsOf('legend').filter((p) => !structural.has(p))
  for (const [kind, make] of kinds) {
    it(`${props.length} properties x three nulls, on ${kind}`, async () => {
      const bad: string[] = []
      const refusedBefore = metRefusals.n
      for (const p of props) {
        const put = (spec: Spec, v: unknown): Spec => ({ ...spec, legends: [{ ...(spec.legends as Spec[])[0]!, [p]: v }] })
        const cfg = (spec: Spec, v: unknown): Spec => ({ ...spec, config: { legend: { [p]: v } } })
        for (const [what, spec] of variants(p, put, cfg, make)) {
          const d = await compare(spec, `${kind}: ${what}`)
          if (d.length) bad.push(`${what}: ${d[0]}`)
        }
      }
      expect(metRefusals.n - refusedBefore, `the config nulls vega.parse refuses on ${kind}`).toBe(REFUSED_ON[kind])
      expect(bad).toEqual([])
    }, 300_000)
  }
})

describe('null in every property of a title', () => {
  const structural = new Set(['text', 'encode'])
  const kinds: Array<[string, () => Spec]> = [
    ['a top title with a subtitle', () => frame({ title: { text: 'Title', subtitle: 'Sub' }, scales: [{ name: 'y', type: 'linear', domain: [0, 1], range: 'height' }], axes: [{ orient: 'left', scale: 'y' }], marks: [] })],
    ['a left title with a subtitle', () => frame({ title: { text: 'Title', subtitle: 'Sub', orient: 'left' }, scales: [{ name: 'y', type: 'linear', domain: [0, 1], range: 'height' }], axes: [{ orient: 'left', scale: 'y' }], marks: [] })],
  ]
  const props = propsOf('title').filter((p) => !structural.has(p))
  for (const [kind, make] of kinds) {
    it(`${props.length} properties x three nulls, on ${kind}`, async () => {
      const bad: string[] = []
      for (const p of props) {
        const put = (spec: Spec, v: unknown): Spec => ({ ...spec, title: { ...(spec.title as Spec), [p]: v } })
        const cfg = (spec: Spec, v: unknown): Spec => ({ ...spec, config: { title: { [p]: v } } })
        for (const [what, spec] of variants(p, put, cfg, make)) {
          const d = await compare(spec, `${kind}: ${what}`)
          if (d.length) bad.push(`${what}: ${d[0]}`)
        }
      }
      expect(bad).toEqual([])
    }, 300_000)
  }
})

describe('what vega.parse refuses is held on its own probe (expected-differences table)', () => {
  it('a legend layout parameter nulled in the config: vega.parse throws, Aster renders', async () => {
    for (const p of REFUSED_LEGEND_LAYOUT) {
      // (the gradient's length is read by a gradient legend only; the layout parameters by a symbol legend)
      const scale = p === 'gradientLength' ? { name: 'c', type: 'linear', domain: [0, 100], range: ['white', 'black'] } : { name: 'c', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' }
      const spec = frame({ scales: [scale], legends: [{ fill: 'c', title: 'Title' }], marks: [], config: { legend: { [p]: null } } })
      let vegaOutcome: unknown
      try { vegaOutcome = { svg: await oracleSvg(spec) } } catch (e) { vegaOutcome = { refused: (e as Error).message.split('\n')[0] } }
      expect(vegaOutcome, `config.legend.${p} = null`).toEqual({ refused: REFUSAL })
      const aster = { svg: renderSpec(structuredClone(spec) as never) }
      expect(() => canonicalizeSvg(aster.svg)).not.toThrow()
      expectKnownDifference('guide-null-vs-vega', 'a legend layout parameter nulled in the config', vegaOutcome, aster)
    }
  })
})

describe('the schema walk is not vacuous', () => {
  it('reads the properties the guides are made of', () => {
    for (const p of ['tickSize', 'labelFontSize', 'domainColor', 'titlePadding', 'labelOffset']) expect(propsOf('axis')).toContain(p)
    for (const p of ['symbolSize', 'gradientLength', 'labelLimit', 'titleOrient', 'columns']) expect(propsOf('legend')).toContain(p)
    for (const p of ['subtitleColor', 'frame', 'offset', 'anchor']) expect(propsOf('title')).toContain(p)
    expect(propsOf('axis').length + propsOf('legend').length + propsOf('title').length).toBeGreaterThan(150)
  })
})
