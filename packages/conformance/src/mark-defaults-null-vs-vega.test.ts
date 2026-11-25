/**
 * A mark's defaults are the config's and the styles', and a channel the encode defines -- an explicit `null` included -- has none
 * (vega-parser applyDefaults: `has(key, encode)`), against real vega (C396).
 *
 * Aster applied a second set of defaults while it built the items and while it drew them (a `point`/`circle`/`square` symbol's
 * stroke width 2, a `trail` style's size 2, a line's stroke width 2), which replaced an explicit null and a config null with 2. The
 * compiled encode carries vega's defaults already. Generated: every mark type with a config block or a style that has defaults, each
 * such channel left out, given a value, given `null`, and nulled in the config block or the style, at the top level and in a group.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { forEngines } from './engines.js'

type Spec = Record<string, unknown>

const MARKS: Array<{ type: string; style?: string; channel: string; set: unknown; base: Spec }> = [
  { type: 'symbol', style: 'point', channel: 'strokeWidth', set: 4, base: { stroke: { value: 'red' }, size: { value: 200 } } },
  { type: 'symbol', style: 'circle', channel: 'strokeWidth', set: 4, base: { stroke: { value: 'red' } } },
  { type: 'symbol', style: 'square', channel: 'strokeWidth', set: 4, base: { stroke: { value: 'red' } } },
  { type: 'symbol', style: 'point', channel: 'size', set: 90, base: { fill: { value: 'red' } } },
  { type: 'trail', style: 'trail', channel: 'size', set: 6, base: {} },
  { type: 'trail', channel: 'size', set: 6, base: {} },
  { type: 'line', channel: 'strokeWidth', set: 5, base: {} },
  { type: 'line', channel: 'stroke', set: 'green', base: {} },
  { type: 'area', channel: 'fill', set: 'green', base: { y2: { value: 80 } } },
  { type: 'text', channel: 'fill', set: 'green', base: { text: { value: 'Tx' } } },
  { type: 'rule', channel: 'stroke', set: 'green', base: { x2: { value: 90 } } },
  { type: 'rect', channel: 'fill', set: 'green', base: { width: { value: 20 }, height: { value: 10 } } },
  { type: 'symbol', channel: 'size', set: 90, base: {} },
]
const FORMS = ['absent', 'value', 'null', 'config-null'] as const

function caseOf(i: number): { id: string; spec: Spec } {
  const m = MARKS[i % MARKS.length]!
  const form = FORMS[Math.floor(i / MARKS.length) % FORMS.length]!
  const nested = Math.floor(i / (MARKS.length * FORMS.length)) % 2 === 1
  const update: Spec = { x: { field: 'x' }, y: { field: 'y' }, ...m.base }
  if (form === 'value') update[m.channel] = { value: m.set }
  if (form === 'null') update[m.channel] = { value: null }
  const config: Spec = {}
  if (form === 'config-null') {
    if (m.style) config.style = { [m.style]: { [m.channel]: null } }
    else config[m.type] = { [m.channel]: null }
  }
  const mark: Spec = { type: m.type, from: { data: 't' }, encode: { update }, ...(m.style ? { style: m.style } : {}) }
  const marks = nested ? [{ type: 'group', encode: { update: { x: { value: 3 }, y: { value: 3 } } }, marks: [mark] }] : [mark]
  const spec = { width: 120, height: 90, padding: 5, autosize: 'none', config, data: [{ name: 't', values: [{ x: 10, y: 20 }, { x: 50, y: 60 }, { x: 90, y: 30 }] }], marks }
  return { id: `${m.type}${m.style ? `/${m.style}` : ''} ${m.channel} ${form}${nested ? ' in a group' : ''}`, spec }
}

async function vegaSvg(spec: Spec): Promise<string> {
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

describe("a mark's defaults are the config's and its styles', and a channel the encode defines has none (C396)", () => {
  it('every defaulted channel left out, set, null and nulled in the config: the same SVG as vega', async () => {
    const N = MARKS.length * FORMS.length * 2
    const bad: string[] = []
    for (let i = 0; i < N; i++) {
      const c = caseOf(i)
      const [oracle, ours] = await forEngines(c.spec, (o, a) => Promise.all([vegaSvg(o), Promise.resolve(renderSpec(a as never))]))
      const d = diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(ours))
      if (d.length) bad.push(`${c.id}: ${d[0]}`)
    }
    expect(bad).toEqual([])
  }, 60_000)
})
