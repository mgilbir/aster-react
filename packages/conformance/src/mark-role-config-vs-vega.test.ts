/**
 * Marks of every type and role against the config that styles them, against real Vega, on the FULL canonical document
 * (paint, geometry and structure).
 *
 * vega-parser reads `config.mark` / `config.<type>` only for a mark whose role is `mark`, `config.group` only for the
 * root frame (and a data mark that calls itself `frame`), and a named `style` for any role. This file generates the
 * product of mark type x role x config block x style x encode override and compares the string renderer to vega.
 *
 * Every cell of the product is compared, and none is excluded. The roles vega's ViewLayout reads an authored mark by (C205):
 *  - `axis`: the mark's first item is laid out as the axis's group item (placed with the half pixel), and its bounds are the mark's,
 *    emptied: the mark adds nothing to the view's bounds;
 *  - `legend`: legendLayout reads `items[0].items[0]`, which a mark of items has not: the walk of the view's layout throws there,
 *    the legends and the title after it are not laid out (nor the view sized), the axes before it were;
 *  - `title`: the last such mark is the title the layout lays out when the view has none; it throws the same way, after the legends
 *    were laid out; one the view's own title follows adds nothing to the bounds;
 *  - `frame`, `scope`: a layout container to vega-parser, whose ViewLayout reads each item as a group item and throws before the
 *    mark is measured: the pass stops at the mark -- or, when the mark reads a scale whose domain reads data, that layout is ranked
 *    among the late operators (see the last block).
 * The same walk runs in every group item (a group mark's layout), which the last block generates too.
 *
 * A GROUP mark whose role is a guide's is the one thing Aster refuses (C205): vega-parser does not make a scope of it (`parseMark`:
 * `nested = role === mark || layout || facet`); what it holds is parsed once in the scope around it, and its marks are attached to the
 * scenegraph by their place among the marks of their container -- the group's one item when it has exactly one, else the root frame,
 * over whatever mark held that place. What vega draws then depends on how many rows the mark's data has and on the marks around it
 * (the probes below pin that). Implementing it is the scenegraph's slot arithmetic, not a behaviour of any chart an author means to
 * draw, so the spec is refused when it is compiled (a `SpecParseError`, docs/ERRORS.md), generated from the parser's own rule.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { SpecParseError, compileChart, renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

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

/** Whether the parser refuses a group mark of this role (see the header): a guide's exact role, or a prefixed one that holds marks. */
const refusedRole = (type: string, role: string | undefined): boolean => type === 'group' && role !== undefined && /^(axis|legend|title)/.test(role)

const ROWS_OF_T = (DATA[0] as { values: unknown[] }).values
const refusal = (spec: Spec): unknown => {
  try { renderSpec(spec as never); return undefined } catch (e) { return e }
}

describe('a group mark with a guide role is refused when the spec is compiled (C205)', () => {
  const group = (role: string, extra: Spec = {}, content: Spec = { marks: [{ type: 'rect', encode: { update: { width: { value: 5 }, height: { value: 5 } } } }] }): Spec => ({
    width: 120, height: 70, data: structuredClone(DATA), scales: [{ name: 'c', type: 'ordinal', domain: ['p', 'q'], range: 'category' }], marks: [{ type: 'group', role, from: { data: 't' }, encode: { update: { width: { value: 20 }, height: { value: 20 } } }, ...content, ...extra }],
  })
  const ROLE_NAMES = ['axis', 'axis-label', 'axis-title', 'legend', 'legend-entry', 'legend-label', 'title', 'title-text', 'title-subtitle']

  // (the evidence the refusal rests on: what vega draws for the same spec changes with the rows of the group's data, and drops marks
  // that were not the group's -- a chart no author could mean)
  it('vega draws the same group mark differently for 0, 1 and 2 rows, and over the marks around it', async () => {
    const rows = (n: number): Spec => {
      const spec = group('axis-label', {}, { marks: [{ type: 'rect', encode: { update: { width: { value: 5 }, height: { value: 5 }, fill: { value: '#f00' } } } }] })
      ;(spec.data as Array<{ values: unknown[] }>)[0]!.values = ROWS_OF_T.slice(0, n)
      return spec
    }
    // (what a scope of the same content draws, whatever its role: the same only for exactly one row)
    const same: boolean[] = []
    for (const n of [0, 1, 2]) {
      const guide = rows(n)
      const scope = structuredClone(guide)
      ;(scope.marks as Spec[])[0]!.role = 'custom'
      same.push(JSON.stringify(canonicalizeSvg(await oracle(guide)).records) === JSON.stringify(canonicalizeSvg(await oracle(scope)).records))
    }
    expect(same, 'vega draws a guide-role group mark as a scope for one row, and not for none or two').toEqual([false, true, false])
    // (and what the group's mark is drawn over: it takes the place of the mark that came first)
    const lead = { type: 'rect', encode: { update: { x: { value: 50 }, y: { value: 50 }, width: { value: 9 }, height: { value: 9 }, fill: { value: '#0a0' } } } }
    const spec = rows(3)
    ;(spec.marks as Spec[]).unshift(lead)
    const green = canonicalizeSvg(await oracle(spec)).records.filter((r) => r.includes('#00aa00')).length
    expect(green, "the group's mark took the place of the mark before it").toBe(0)
    const alone = canonicalizeSvg(await oracle({ ...spec, marks: [lead] })).records.filter((r) => r.includes('#00aa00')).length
    expect(alone, 'that mark is drawn when it is alone').toBeGreaterThan(0)
  })

  for (const role of ROLE_NAMES) {
    it(`role ${role}: refused whatever it holds (exact roles) or when it holds anything (prefixed)`, () => {
      const exact = role === 'axis' || role === 'legend' || role === 'title'
      for (const content of [{}, { marks: [{ type: 'rect' }] }, { signals: [{ name: 's', value: 1 }] }, { scales: [{ name: 'z', type: 'linear', domain: [0, 1], range: [0, 1] }] }, { data: [{ name: 'u', values: [] }] }, { axes: [{ scale: 'c', orient: 'left' }] }, { title: 'T' }]) {
        const e = refusal(group(role, {}, content))
        const empty = Object.keys(content).length === 0
        if (empty && !exact) expect(e, `${role} with nothing in it`).toBeUndefined()
        else {
          expect(e, `${role} ${JSON.stringify(content).slice(0, 40)}`).toBeInstanceOf(SpecParseError)
          expect((e as Error).message).toMatch(new RegExp(`^\\[aster\\] a group mark with the role "${role}"`))
          // (from the compile alone: no data is read, nothing is evaluated)
          expect(() => compileChart(group(role, {}, content) as never)).toThrow(SpecParseError)
        }
      }
    })
  }

  it("vega's own errors come first: a duplicate name inside such a group mark is vega's message, not the refusal", async () => {
    const spec = group('axis-label', {}, { data: [{ name: 'u', values: [] }, { name: 'u', values: [] }] })
    const want = await oracle(spec).then(() => undefined, (e: Error) => e.message)
    expect(want).toMatch(/^Duplicate data set name/)
    expect((refusal(spec) as Error).message).toBe(want)
  })

  it('a prefixed role is no refusal where vega makes a scope of it: a layout or a facet, and the cells compare with vega', async () => {
    for (const extra of [{ layout: { columns: 1 } }, { from: { facet: { data: 't', name: 'f', groupby: 'k' } } }]) {
      const spec = group('axis-label', extra)
      expect(refusal(spec)).toBeUndefined()
      expect(diffCanonical(canonicalizeSvg(await oracle(spec)), canonicalizeSvg(renderSpec(spec as never)))).toEqual([])
    }
  })

  it('a prefixed role with nothing in it is a group mark like any other', async () => {
    for (const role of ['axis-label', 'legend-entry', 'title-text']) for (const n of [0, 1, 2]) {
      const spec = group(role, {}, {})
      ;(spec.data as Array<{ values: unknown[] }>)[0]!.values = ROWS_OF_T.slice(0, n)
      expect(diffCanonical(canonicalizeSvg(await oracle(spec)), canonicalizeSvg(renderSpec(spec as never))), `${role} x ${n} rows`).toEqual([])
    }
  })
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
          // (a group mark with a guide's role holds a mark here: refused, see above -- it is no cell to compare)
          if (refusedRole(type, role)) {
            if (!(refusal(spec) instanceof SpecParseError)) bad.push(`${type} role=${role} ${cn} ${sn} ${en} guides=${guides}: not refused`)
            continue
          }
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

// ------------------------------------------------------------------------------------------------------------------------------
// Operators ranked late (C205). vega runs the operators of a pass in rank order and stops at the first that throws. A scale whose
// domain reads data -- and everything that reads it: an encode, the ticks of an axis, the entries of a legend, a mark's layout -- is
// ranked after every operator that reads no such scale. So when the operator that stops the pass reads one (a `frame` / `scope`
// mark's failing layout, an encode over it), everything ranked before it ran, the marks that read no late scale included; and when it
// reads none (a mark's encode that throws, a failing strip, a failing tick count), the late scales are never evaluated: the marks that
// read them are joined and left unencoded, a legend over one has its title and no entries, no guide over one has a caption, and an
// axis over one has no ticks -- a scenegraph with holes that vega's own serialiser cannot walk, which Aster refuses as it refuses a
// failing tick count. The same holds inside a group item, whose scope has its own late scales.

const ROWS = [{ k: 'a', v: 3, g: 'n' }, { k: 'b', v: 8, g: 's' }, { k: 'c', v: 5, g: 'e' }]
const LATE_SCALES = [
  { name: 'late', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' },
  { name: 'early', type: 'linear', domain: [0, 10], range: 'height' },
  { name: 'cat', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
  { name: 'cat0', type: 'ordinal', domain: ['p', 'q'], range: 'category' },
]
const leaf = (u: Spec, extra: Spec = {}): Spec => ({ type: 'rect', from: { data: 't' }, ...extra, encode: { update: { y: { value: 1 }, width: { value: 9 }, height: { value: 9 }, ...u } } })
const THROWS = { signal: 'datum.no.x' }
/** What stops the pass (or fails in the layout), and the marks, guides and title it brings. */
const STOPS: Record<string, Spec> = {
  'frame over a late scale': { marks: [leaf({ x: { scale: 'late', field: 'k' } }, { role: 'frame' })] },
  'scope over a late scale': { marks: [leaf({ x: { scale: 'late', field: 'k' } }, { role: 'scope' })] },
  'frame over an early scale': { marks: [leaf({ x: { scale: 'early', field: 'v' } }, { role: 'frame' })] },
  'an encode that throws': { marks: [leaf({ x: THROWS })] },
  'an encode that throws over a late scale': { marks: [leaf({ x: { scale: 'late', field: 'k' }, fill: THROWS })] },
  'ticks that fail': { marks: [], axes: [{ orient: 'right', scale: 'early', tickCount: 'week' }], bareAxes: true },
  'ticks that fail over a late scale': { marks: [], axes: [{ orient: 'top', scale: 'late', tickCount: 'week' }], bareAxes: true },
  'a title whose encode throws': { marks: [], title: { text: 'Q', encode: { title: { update: { fill: THROWS } } } } },
  'a strip that throws': { marks: [], legends: [{ fill: 'cat0', type: 'gradient', encode: { gradient: { update: { fill: THROWS } } } }] },
  'a strip that throws, over a late scale': { marks: [], legends: [{ fill: 'cat', type: 'gradient', encode: { gradient: { update: { fill: THROWS } } } }] },
  'symbols that throw': { marks: [], legends: [{ fill: 'cat0', encode: { symbols: { update: { size: THROWS } } } }] },
  'a legend role over a late scale': { marks: [leaf({ x: { scale: 'late', field: 'k' } }, { role: 'legend' })] },
  'an axis role over a late scale': { marks: [leaf({ x: { scale: 'late', field: 'k' } }, { role: 'axis' })] },
  'a title role over a late scale': { marks: [leaf({ x: { scale: 'late', field: 'k' } }, { role: 'title' })] },
}
const WITNESSES: Record<string, Spec[]> = {
  none: [],
  'a mark over a late scale': [leaf({ x: { scale: 'late', field: 'k' } })],
  'a mark over an early scale': [leaf({ x: { scale: 'early', field: 'v' } })],
  'a mark over no scale': [leaf({ x: { value: 40 } })],
  // (a group mark after the operator that stopped the pass: its items are made, and hold nothing)
  'a group mark over a late scale': [{ type: 'group', from: { data: 't' }, encode: { update: { x: { scale: 'late', field: 'k' }, y: { value: 3 }, width: { value: 10 }, height: { value: 10 } } }, marks: [leaf({ x: { value: 1 } })] }],
  'a group mark over no scale': [{ type: 'group', from: { data: 't' }, encode: { update: { x: { value: 3 }, y: { value: 3 }, width: { value: 10 }, height: { value: 10 } } }, marks: [leaf({ x: { value: 1 } })] }],
}
const AXES: Record<string, Spec[]> = { none: [], 'over an early scale': [{ orient: 'left', scale: 'early', title: 'E' }], 'over a late scale': [{ orient: 'bottom', scale: 'late', title: 'L' }] }
const HOSTS = ['the view', 'a group item', 'three group items', 'a group item in a group item'] as const

/** The spec with its scales, axes, legends, title and marks in the view, or in a group (whose data set `u` is the scales' own scope). */
function hosted(host: (typeof HOSTS)[number], inner: Spec): Spec {
  const base: Spec = { width: 160, height: 100, padding: 5, autosize: 'pad', data: [{ name: 't', values: ROWS }] }
  if (host === 'the view') return { ...base, ...inner }
  const { scales, axes, marks, legends, title } = inner as { scales: Spec[]; axes?: Spec[]; marks: Spec[]; legends?: Spec[]; title?: unknown }
  // (the scales' data is the group's own, so they are ranked late inside it: a scale whose domain reads a data set of its own scope)
  const own = scales.map((sc) => (sc.domain !== null && typeof sc.domain === 'object' && 'data' in (sc.domain as Spec) ? { ...sc, domain: { ...(sc.domain as Spec), data: 'u' } } : sc))
  const group: Spec = {
    type: 'group', ...(host === 'three group items' ? { from: { data: 't' } } : {}),
    encode: { update: { width: { value: 60 }, height: { value: 50 }, x: { signal: 'datum.v * 6' }, stroke: { value: '#999' } } },
    data: [{ name: 'u', source: 't' }], scales: own,
    ...(axes?.length ? { axes } : {}), ...(legends?.length ? { legends } : {}), ...(title !== undefined ? { title } : {}),
    marks: marks.map((m) => (m.from ? { ...m, from: { data: 'u' } } : m)),
  }
  const wrapped = host === 'a group item in a group item' ? { type: 'group', encode: { update: { width: { value: 150 }, height: { value: 90 }, stroke: { value: '#c00' } } }, marks: [group] } : group
  return { ...base, marks: [wrapped] }
}

type Outcome = { svg: string } | { threw: string }
async function vegaOutcome(spec: Spec): Promise<Outcome> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(structuredClone(spec) as never), { renderer: 'none', logLevel: 0 })
  try { await view.runAsync(); return { svg: await view.toSVG() } } catch (e) { return { threw: (e as Error).message } } finally { view.finalize() }
}
function asterOutcome(spec: Spec): Outcome {
  const log = console.error
  console.error = () => {}
  try { return { svg: renderSpec(spec as never) } } catch (e) { return { threw: (e as Error).message } } finally { console.error = log }
}

describe('operators ranked late: what a failing operator leaves, over every host, mark, guide and title (C205)', () => {
  const run = async (hosts: readonly (typeof HOSTS)[number][]): Promise<{ bad: string[]; n: number; drawn: number; refused: number }> => {
    const bad: string[] = []
    let n = 0, drawn = 0, refused = 0
    for (const host of hosts) for (const [stop, f] of Object.entries(STOPS)) for (const [wn, w] of Object.entries(WITNESSES)) for (const before of [false, true]) for (const [an, ax] of Object.entries(AXES)) for (const lg of ['none', 'cat', 'cat0']) for (const withTitle of [false, true]) {
      // (a failing tick count is the one failing axis: no other axis with it; a legend that fails is the legend: no other with it)
      if (f.bareAxes && an !== 'none') continue
      if (lg !== 'none' && (stop === 'a strip that throws' || stop === 'a strip that throws, over a late scale' || stop === 'symbols that throw')) continue
      const marks = before ? [...w, ...(f.marks as Spec[])] : [...(f.marks as Spec[]), ...w]
      const legends = [...((f.legends as Spec[] | undefined) ?? []), ...(lg !== 'none' ? [{ fill: lg, ...(withTitle ? { title: 'Legend title', encode: { title: { update: { fill: { value: '#c00' }, fontSize: { value: 14 } } } } } : {}) }] : [])]
      const spec = hosted(host, {
        scales: LATE_SCALES, axes: [...ax, ...((f.axes as Spec[] | undefined) ?? [])], marks,
        ...(legends.length ? { legends } : {}), ...(f.title !== undefined ? { title: f.title } : withTitle ? { title: 'T' } : {}),
      })
      n++
      const want = await vegaOutcome(spec)
      const got = asterOutcome(spec)
      const label = `${host} | ${stop} | witness: ${wn} ${before ? 'before' : 'after'} | axis ${an} | legend ${lg} | title ${withTitle}`
      if ('threw' in want || 'threw' in got) {
        // (a scenegraph vega cannot serialise is a chart Aster refuses, with the reason)
        if ('threw' in want !== 'threw' in got) bad.push(`${label}: vega ${'threw' in want ? 'throws' : 'draws'}, Aster ${'threw' in got ? 'throws' : 'draws'}`)
        else if (!/^\[aster\] the ticks of the axis over scale/.test((got as { threw: string }).threw)) bad.push(`${label}: Aster refuses with another reason: ${(got as { threw: string }).threw.slice(0, 100)}`)
        else refused++
        continue
      }
      drawn++
      const d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))
      if (d.length) bad.push(`${label}: ${d[0]!.slice(0, 120)}`)
    }
    return { bad, n, drawn, refused }
  }
  for (const host of HOSTS) {
    it(`in ${host}`, async () => {
      const { bad, n, drawn, refused } = await run([host])
      expect(bad, `${bad.length} of ${n} diverge`).toEqual([])
      // (not vacuous: vega draws most of them, and cannot draw the others)
      expect(drawn).toBeGreaterThan(n / 3)
      expect(refused).toBeGreaterThan(10)
    }, 600_000)
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
