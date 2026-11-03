/**
 * Marks of every type and role against the config that styles them, against real Vega, on the FULL canonical document
 * (paint, geometry and structure).
 *
 * vega-parser reads `config.mark` / `config.<type>` only for a mark whose role is `mark`, `config.group` only for the
 * root frame (and a data mark that calls itself `frame`), and a named `style` for any role. This file generates the
 * product of mark type x role x config block x style x encode override and compares the string renderer to vega.
 *
 * Excluded, exactly (both are layout divergences with no config in them, documented in aria-guides-vs-vega.test.ts):
 *  - a GROUP mark whose role starts with axis / legend / title (vega keeps that role and lays the mark out as a guide);
 *  - a DATA mark whose role is `frame` or `scope` while the chart has a legend or a title (vega then drops them), and a
 *    stroked `area` with either role even without them (vega's parser makes such a mark a layout container: its stroke
 *    does not grow the view as it does for every other role). Every other type with these roles is generated in charts
 *    with neither, and so is config.group on them.
 *  - a third class this file found: a DATA mark whose role is exactly `axis`, `legend` or `title` (vega's ViewLayout
 *    lays it out as the guide: offsets it by half a pixel, takes the legends away). The guide-prefixed roles
 *    (`axis-label`, `legend-entry`, `title-text`, `title-subtitle`) are generated.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracle(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never), { renderer: 'none', logLevel: 0 })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

const DATA = [{ name: 't', values: [{ k: 'a', v: 3 }, { k: 'b', v: 9 }, { k: 'c', v: 6 }] }]
const TYPES = ['rect', 'symbol', 'text', 'line', 'area', 'rule', 'arc', 'path', 'trail', 'group'] as const
const ROLES: Array<string | undefined> = [undefined, 'mark', 'custom', 'axis', 'axis-label', 'legend', 'legend-entry', 'title', 'title-text', 'title-subtitle', 'frame', 'scope']
const CONFIGS: Array<[string, Spec | undefined]> = [
  ['none', undefined],
  ['config.mark', { mark: { fill: '#fe0', stroke: '#0af', strokeWidth: 3, opacity: 0.5, description: 'cm' } }],
  ['config.<type>', { rect: { fill: '#e00' }, symbol: { fill: '#e00', size: 200 }, text: { fill: '#0a0', fontSize: 16 }, line: { stroke: '#e00', strokeWidth: 4 }, area: { fill: '#e00' }, rule: { stroke: '#e00' }, arc: { fill: '#e00' }, path: { stroke: '#e00' }, trail: { fill: '#e00' }, group: { fill: '#eef', stroke: '#00f' } }],
  ['config.group', { group: { fill: '#fee', stroke: '#f00', strokeWidth: 2, description: 'cg' } }],
  ['both', { mark: { opacity: 0.4 }, rect: { fill: '#909' }, text: { fontSize: 20 }, group: { fill: '#efe' } }],
  ['named styles', { style: { s1: { fill: '#0c0', stroke: '#030', strokeWidth: 2, opacity: 0.7 }, s2: { fontSize: 18, fill: '#00c' } } }],
]
const STYLES: Array<[string, unknown]> = [['no style', undefined], ['one style', 's1'], ['two styles', ['s1', 's2']]]
const ENCODES: Array<[string, Spec]> = [['no override', {}], ['fill override', { fill: { value: '#123' } }], ['stroke override', { stroke: { value: '#456' } }], ['opacity override', { opacity: { value: 0.9 } }]]

function chart(type: string, role: string | undefined, config: Spec | undefined, style: unknown, enc: Spec, guides: boolean): Spec {
  // (only the channels the type reads: a channel the type ignores is a different matter, see the end of this file)
  const geo: Record<string, Spec> = {
    rect: { x: { value: 10 }, y: { value: 10 }, width: { value: 20 }, height: { value: 20 } },
    symbol: { x: { value: 20 }, y: { value: 20 } },
    text: { x: { value: 10 }, y: { value: 20 }, text: { field: 'k' } },
    line: { x: { field: 'v', mult: 5 }, y: { field: 'v', mult: 3 } },
    area: { x: { field: 'v', mult: 5 }, y: { field: 'v', mult: 3 }, y2: { value: 0 } },
    rule: { x: { value: 10 }, y: { value: 10 }, x2: { value: 80 }, y2: { value: 50 } },
    arc: { x: { value: 30 }, y: { value: 30 }, outerRadius: { value: 12 }, startAngle: { value: 0 }, endAngle: { value: 3 } },
    path: { path: { value: 'M5,5L40,5L40,40Z' } },
    trail: { x: { field: 'v', mult: 5 }, y: { field: 'v', mult: 3 }, size: { value: 4 } },
    group: { x: { value: 10 }, y: { value: 10 }, width: { value: 20 }, height: { value: 20 } },
  }
  const update: Spec = { ...geo[type], ...enc }
  const m: Spec = { type, from: { data: 't' }, encode: { update } }
  if (role !== undefined) m.role = role
  if (style !== undefined) m.style = style
  if (type === 'group') m.marks = [{ type: 'rect', encode: { update: { width: { value: 5 }, height: { value: 5 } } } }]
  return {
    width: 120, height: 70, padding: 6, autosize: 'pad', data: DATA,
    scales: [{ name: 'c', type: 'ordinal', domain: ['p', 'q'], range: 'category' }],
    ...(guides ? { legends: [{ fill: 'c' }], title: 'T' } : {}),
    marks: [m], ...(config ? { config } : {}),
  }
}

const excluded = (type: string, role: string | undefined, guides: boolean): boolean =>
  (type === 'group' && role !== undefined && /^(axis|legend|title)/.test(role)) || (type !== 'group' && (role === 'frame' || role === 'scope') && (guides || type === 'area'))
  // (third class, found by this file: vega's layout treats a DATA mark whose role is exactly axis / legend / title as the guide)
  || (type !== 'group' && (role === 'axis' || role === 'legend' || role === 'title'))

describe('mark type x role x config x style x encode, full document', () => {
  for (const type of TYPES) {
    it(`${type} marks`, async () => {
      const bad: string[] = []
      let n = 0
      for (const role of ROLES) for (const [cn, cfg] of CONFIGS) for (const [sn, st] of STYLES) for (const [en, enc] of ENCODES) {
        // (the product is cut where it only repeats itself: encode overrides ride on the first style, styles on two configs)
        if (en !== 'no override' && sn !== 'no style') continue
        if (sn !== 'no style' && cn !== 'none' && cn !== 'named styles') continue
        for (const guides of [false, true]) {
          if (excluded(type, role, guides)) continue
          const spec = chart(type, role, cfg, st, enc, guides)
          n++
          const want = canonicalizeSvg(await oracle(spec))
          const d = diffCanonical(want, canonicalizeSvg(renderSpec(spec as never)))
          if (d.length) bad.push(`${type} role=${role} ${cn} ${sn} ${en} guides=${guides}: ${d.slice(0, 2).join(' | ').slice(0, 260)}`)
        }
      }
      expect(n).toBeGreaterThan(200)
      expect(bad, `${bad.length} of ${n} diverge`).toEqual([])
    }, 300_000)
  }
})

describe('a channel the mark type does not read is inert', () => {
  const geo: Record<string, Spec> = {
    rect: { x: { value: 2 }, y: { value: 2 }, width: { value: 20 }, height: { value: 20 } },
    symbol: { x: { value: 3 }, y: { value: 3 } },
    rule: { x: { value: 10 }, y: { value: 10 }, x2: { value: 80 }, y2: { value: 50 } },
    arc: { x: { value: 30 }, y: { value: 30 }, outerRadius: { value: 12 } },
    line: { x: { field: 'v', mult: 5 }, y: { field: 'v', mult: 3 } },
  }
  const stray: Array<[string, Spec]> = [
    ['text', { text: { field: 'k' } }], ['outerRadius', { outerRadius: { value: 12 } }], ['startAngle and endAngle', { startAngle: { value: 1 }, endAngle: { value: 2 } }],
    ['width and height', { width: { value: 9 }, height: { value: 9 } }], ['fontSize and angle', { fontSize: { value: 30 }, angle: { value: 20 } }],
  ]
  for (const [type, own] of Object.entries(geo)) {
    for (const [sn, extra] of stray) {
      for (const stroke of [false, true]) {
        it(`${type} with ${sn}${stroke ? ', stroked' : ''}`, async () => {
          const spec: Spec = {
            width: 100, height: 60, padding: 5, autosize: 'pad', data: DATA,
            marks: [{ type, from: { data: 't' }, encode: { update: { ...own, ...extra, ...(stroke ? { stroke: { value: '#000' }, strokeWidth: { value: 3 } } : {}) } } }],
          }
          const d = diffCanonical(canonicalizeSvg(await oracle(spec)), canonicalizeSvg(renderSpec(spec as never)))
          expect(d).toEqual([])
        })
      }
    }
  }
})
