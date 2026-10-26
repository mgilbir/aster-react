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
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import schema from '../node_modules/vega/build/vega-schema.json' with { type: 'json' }

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const log = console.error
  console.error = () => {}
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    console.error = log
    view.finalize()
  }
}

/**
 * The cases the oracle itself cannot answer: `vega.parse` refuses the spec (a config that nulls a layout parameter makes the
 * parser write `undefined` into an expression), or its document is one the canonicalizer cannot read (a NaN transform).
 * They are agreements on nothing, so they are counted, not compared -- like the sweeps' node errors, and held to a ceiling.
 */
const unanswered: string[] = []

async function compare(spec: Spec, what: string): Promise<string[]> {
  let want: string
  try {
    want = await oracleSvg(spec)
  } catch (e) {
    unanswered.push(`${what}: vega: ${(e as Error).message.split('\n')[0]}`)
    return []
  }
  let canon
  try {
    canon = canonicalizeSvg(want)
  } catch (e) {
    unanswered.push(`${what}: canonicalizer: ${(e as Error).message.split('\n')[0]}`)
    return []
  }
  return diffCanonical(canon, canonicalizeSvg(renderSpec(spec as never)))
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
      for (const p of props) {
        const put = (spec: Spec, v: unknown): Spec => ({ ...spec, legends: [{ ...(spec.legends as Spec[])[0]!, [p]: v }] })
        const cfg = (spec: Spec, v: unknown): Spec => ({ ...spec, config: { legend: { [p]: v } } })
        for (const [what, spec] of variants(p, put, cfg, make)) {
          const d = await compare(spec, `${kind}: ${what}`)
          if (d.length) bad.push(`${what}: ${d[0]}`)
        }
      }
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

describe('what the oracle could not answer', () => {
  it('is a handful of config nulls that make vega.parse write `undefined` into an expression, or a NaN transform', () => {
    // (runs after the walks above, in file order)
    expect(unanswered.filter((u) => !/Unrecognized signal name: "undefined"|non-finite transform/.test(u))).toEqual([])
    expect(unanswered.length).toBeLessThanOrEqual(14)
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
