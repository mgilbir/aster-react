/**
 * Marks of every type and role against the config that styles them, against real Vega, on the FULL canonical document
 * (paint, geometry and structure).
 *
 * vega-parser reads `config.mark` / `config.<type>` only for a mark whose role is `mark`, `config.group` only for the
 * root frame (and a data mark that calls itself `frame`), and a named `style` for any role. This file generates the
 * product of mark type x role x config block x style x encode override and compares the string renderer to vega.
 *
 * Not an exclusion: every cell of the product is compared. A cell that differs must belong to the named class of
 * `scripts/lib/expected-differences.mjs` (a GROUP mark whose role starts with axis / legend / title: vega-parser does not make a
 * scope of it, parses what it holds once in the scope around it and draws no container for it -- C205, open), the matrix fails a
 * difference outside it, and the class is held to STILL DIFFER on its own probe (so a fix on either side fails until the entry is
 * removed).
 *
 * Fixed, and compared in every cell (C205): the roles vega's ViewLayout reads an authored mark by --
 *  - `axis`: the mark's first item is laid out as the axis's group item (placed with the half pixel), and its bounds are the mark's,
 *    emptied: the mark adds nothing to the view's bounds;
 *  - `legend`: legendLayout reads `items[0].items[0]`, which a mark of items has not: the walk of the view's layout throws there,
 *    the legends and the title after it are not laid out (nor the view sized), the axes before it were;
 *  - `title`: the last such mark is the title the layout lays out when the view has none; it throws the same way, after the legends
 *    were laid out; one the view's own title follows adds nothing to the bounds;
 *  - `frame`, `scope`: a layout container to vega-parser, whose ViewLayout reads each item as a group item and throws before the
 *    mark is measured: the pass stops at the mark.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { expectKnownDifference } from './known-differences.js'

type Spec = Record<string, unknown>

async function oracle(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(structuredClone(spec) as never), { renderer: 'none', logLevel: 0 })
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

const FILE = 'mark-role-config-vs-vega'

/** The named classes of difference: what tells one apart, and the probe cell that must still show it. */
const KNOWN: Array<{ name: string; in: (type: string, role: string | undefined, guides: boolean) => boolean; probe: [type: string, role: string, guides: boolean, enc: Spec] }> = [
  { name: 'a group mark whose role starts with axis, legend or title', in: (t, r) => t === 'group' && r !== undefined && /^(axis|legend|title)/.test(r), probe: ['group', 'axis', false, {}] },
]
const classOf = (type: string, role: string | undefined, guides: boolean): string | undefined => KNOWN.find((k) => k.in(type, role, guides))?.name

describe('the known differences of an authored mark role still differ (C205)', () => {
  for (const k of KNOWN) {
    it(k.name, async () => {
      const [type, role, guides, enc] = k.probe
      expect(k.in(type, role, guides), 'the probe belongs to its class').toBe(true)
      const spec = chart(type, role, undefined, undefined, enc, guides)
      expectKnownDifference(FILE, k.name, canonicalizeSvg(await oracle(spec)), canonicalizeSvg(renderSpec(spec as never)))
    })
  }
})

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
          const spec = chart(type, role, cfg, st, enc, guides)
          n++
          const want = canonicalizeSvg(await oracle(spec))
          const d = diffCanonical(want, canonicalizeSvg(renderSpec(spec as never)))
          if (d.length && classOf(type, role, guides) !== undefined) continue // (a named class: held on its probe above)
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
