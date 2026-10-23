// @vitest-environment jsdom
/**
 * Accessibility structure of guides and titles (audit N3).
 *
 * vega-scenegraph draws an axis, a legend and a title as group marks: a container
 * `<g class="mark-group role-axis" role="graphics-symbol" aria-roledescription="axis" aria-label="...">`
 * holding one `<g>` per item (background path, the guide's marks in their own containers, foreground path).
 * Screen readers read exactly that, so the strict canonicalizer compares the ARIA and the nesting
 * (normalize.ts N-structure). Each chart below is rendered by real vega, by the string renderer and by the
 * DOM path; all three must have the same structure, and the chart must really have the guide (a
 * vacuous comparison proves nothing).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracle(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never), { renderer: 'none', logLevel: 0 })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally { view.finalize() }
}

function asterSvgs(spec: Spec): { string: string; dom: string } {
  const scene = evaluateChart(compileChart(spec as never))
  const dom = new XMLSerializer().serializeToString(renderSceneToDomElement(scene, document) as unknown as Node)
  return { string: renderSceneToSvg(scene), dom }
}

const DATA = [{ name: 't', values: [{ k: 'a', v: 3, g: 'p' }, { k: 'b', v: 9, g: 'q' }, { k: 'c', v: 6, g: 'p' }] }]
const SCALES = [
  { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
  { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true },
  { name: 'cat', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
  { name: 'seq', type: 'linear', domain: { data: 't', field: 'v' }, range: ['#eee', '#06c'] },
  { name: 'q', type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] },
  { name: 'sz', type: 'linear', domain: { data: 't', field: 'v' }, range: [20, 200] },
]
const chart = (more: Spec): Spec => ({ width: 160, height: 90, padding: 8, autosize: 'pad', data: DATA, scales: SCALES, marks: [], ...more })

/** [name, spec, the vega structure lines that must be there] */
const CASES: Array<[string, Spec, RegExp[]]> = [
  ['bottom axis with a title', chart({ axes: [{ scale: 'x', orient: 'bottom', title: 'Category' }] }),
    [/role-axis role=graphics-symbol rd=axis label="X-axis titled 'Category' for a discrete scale/, /mark-rule\.role-axis-tick/, /mark-text\.role-axis-label/, /mark-rule\.role-axis-domain/, /mark-text\.role-axis-title/]],
  ['left axis with a grid', chart({ axes: [{ scale: 'y', orient: 'left', grid: true }] }),
    [/role-axis role=graphics-symbol rd=axis label="Y-axis for a linear scale with values from 0 to \d+"/, /mark-rule\.role-axis-grid/]],
  ['top and right axes', chart({ axes: [{ scale: 'x', orient: 'top' }, { scale: 'y', orient: 'right', title: 'Y' }] }), [/X-axis/, /Y-axis titled 'Y'/]],
  ['axis with grid only', chart({ axes: [{ scale: 'y', orient: 'left', grid: true, ticks: false, labels: false, domain: false }] }), [/mark-rule\.role-axis-grid/]],
  ['axis with labels only', chart({ axes: [{ scale: 'y', orient: 'left', ticks: false, domain: false }] }), [/mark-text\.role-axis-label/]],
  ['axis that draws nothing has no ARIA', chart({ axes: [{ scale: 'y', orient: 'left', ticks: false, labels: false, domain: false }] }), [/g \.mark-group\.role-axis$/]],
  ['axis with aria: false', chart({ axes: [{ scale: 'x', orient: 'bottom', aria: false }] }), [/role-axis hidden=true/]],
  ['axis with a description', chart({ axes: [{ scale: 'x', orient: 'bottom', description: 'my axis' }] }), [/label="my axis"/]],
  ['axis title replaced by its encode', chart({ axes: [{ scale: 'x', orient: 'bottom', title: 'Axis title', encode: { title: { update: { text: { value: 'Replaced' } } } } }] }), [/titled 'Replaced'/]],
  ['symbol legend with a title', chart({ legends: [{ fill: 'cat', title: 'Group' }] }),
    [/role-legend role=graphics-symbol rd=legend label="Symbol legend titled 'Group' for fill color with 2 values: p, q"/, /mark-group\.role-legend-entry/, /mark-group\.role-scope role=graphics-object/, /mark-symbol\.role-legend-symbol/, /mark-text\.role-legend-label/, /mark-text\.role-legend-title/]],
  ['symbol legend without a title, two columns', chart({ legends: [{ fill: 'cat', columns: 2 }] }), [/Symbol legend for fill color/]],
  ['size legend', chart({ legends: [{ size: 'sz', title: 'Size' }] }), [/Symbol legend titled 'Size' for size/]],
  ['legend over two channels is a symbol legend', chart({ legends: [{ size: 'sz', fill: 'seq' }] }), [/Symbol legend for size and fill color/]],
  ['vertical gradient legend', chart({ legends: [{ fill: 'seq', title: 'Value' }] }), [/Gradient legend titled 'Value' for fill color with values from \d+ to \d+/, /mark-rect\.role-legend-gradient/]],
  ['horizontal gradient legend', chart({ legends: [{ fill: 'seq', orient: 'top', direction: 'horizontal', title: 'Value' }] }), [/mark-rect\.role-legend-gradient/]],
  ['discrete (quantize) legend', chart({ legends: [{ fill: 'q', title: 'Bands' }] }), [/Discrete legend titled 'Bands'/, /mark-rect\.role-legend-band/]],
  ['legend with aria: false', chart({ legends: [{ fill: 'cat', aria: false }] }), [/role-legend hidden=true/]],
  ['legend with a description', chart({ legends: [{ fill: 'cat', description: 'colours' }] }), [/label="colours"/]],
  ['legend title replaced by its encode', chart({ legends: [{ fill: 'cat', title: 'T', encode: { title: { update: { text: { value: 'Replaced' } } } } }] }), [/titled 'Replaced'/]],
  ['title', chart({ title: { text: 'A chart' } }),
    [/role-title$/, /mark-text\.role-title-text role=graphics-symbol rd=title label="Title text 'A chart'"/]],
  ['title with a subtitle', chart({ title: { text: 'A chart', subtitle: 'about things' } }), [/rd=subtitle label="Subtitle text 'about things'"/]],
  ['multi-line title', chart({ title: { text: ['line one', 'line two'] } }), [/Title text 'line one line two'/]],
  ['title with aria: false', chart({ title: { text: 'Hidden', aria: false } }), [/role-title hidden=true/]],
  ['axes, legend and title together', chart({ title: 'T', axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }], legends: [{ fill: 'cat' }] }), [/rd=axis/, /rd=legend/, /rd=title/]],
  ['guides of a nested group', chart({
    marks: [{ type: 'group', encode: { update: { width: { value: 120 }, height: { value: 60 } } }, scales: [{ name: 'gx', type: 'linear', domain: [0, 5], range: 'width' }], axes: [{ scale: 'gx', orient: 'bottom', title: 'inner' }], title: { text: 'cell' } }],
  }), [/X-axis titled 'inner' for a linear scale/, /Title text 'cell'/]],
]

describe('guides and titles have the structure and ARIA vega writes (N3)', () => {
  for (const [name, spec, expected] of CASES) {
    it(name, async () => {
      const want = canonicalizeSvg(await oracle(spec))
      // the oracle really has the guide: the comparison below is not an empty one
      for (const re of expected) expect(want.structure.some((l) => re.test(l.trim())), `${re} is in vega's structure`).toBe(true)
      const got = asterSvgs(spec)
      // (the discrete legend's own label format and width differ from vega's, a separate defect: only its structure is held here)
      const only = name.startsWith('discrete')
      const judged = (g: string): string[] => diffCanonical(want, canonicalizeSvg(g)).filter((d) => !only || d.startsWith('structure:'))
      expect(judged(got.string), 'string renderer').toEqual([])
      expect(judged(got.dom), 'DOM path').toEqual([])
    })
  }

  it('the user-controlled text of a caption is escaped, not interpreted', async () => {
    const hostile = `"><script>alert(1)</script>'&`
    const spec = chart({ axes: [{ scale: 'x', orient: 'bottom', title: hostile }], legends: [{ fill: 'cat', title: hostile, description: hostile }], title: hostile })
    const got = asterSvgs(spec)
    const scene = evaluateChart(compileChart(spec as never))
    const doc = new DOMParser().parseFromString(got.string, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    for (const root of [doc.documentElement, renderSceneToDomElement(scene, document)]) {
      expect(root.querySelector('script')).toBeNull()
      const labels = [...root.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'))
      expect(labels.some((l) => l?.includes(hostile)), 'the caption quotes the text, unchanged').toBe(true)
    }
    // ... and vega agrees on what the captions quote (the double quote left out: the canonicalizer compares
    // text nodes as written, and vega and the renderer spell that one differently)
    const plain = `<script>alert(1)</script>'&`
    const quoted = chart({ axes: [{ scale: 'x', orient: 'bottom', title: plain }], legends: [{ fill: 'cat', title: plain }], title: plain })
    expect(diffCanonical(canonicalizeSvg(await oracle(quoted)), canonicalizeSvg(asterSvgs(quoted).string))).toEqual([])
  })
})
