// @vitest-environment node
/**
 * @aster-charts/vl against vega-lite 6.4.3, for the mark-encoding paths (audit lane a14): the properties a mark takes from its mark
 * definition, its named styles and the config, the invalid-value modes, conditions and formats, and the band / size geometry of the
 * rect-based marks. Each family is generated (every mark type, every channel form it concerns), both compilers' output is run by REAL
 * vega, and the canonical SVGs are compared exactly together with the scenegraph's item counts, so a mark drawn twice or a property
 * that is not applied fails the case even where the picture is the same.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import * as vega from 'vega'
import { compile } from '@aster-charts/vl'
import { renderWithVega, renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

type Spec = Record<string, any>
const DATA = {
  values: [
    { a: 'A', b: 28, c: 3, d: '2020-01-01', g: 'x', k: 'p' },
    { a: 'B', b: 55, c: 7, d: '2020-02-01', g: 'y', k: 'p' },
    { a: 'C', b: 43, c: 1, d: '2020-03-01', g: 'x', k: 'q' },
    { a: 'A', b: 91, c: 9, d: '2020-04-01', g: 'y', k: 'q' },
    { a: 'B', b: 81, c: 4, d: '2020-05-01', g: 'x', k: 'p' },
    { a: 'C', b: 5, c: 6, d: '2020-06-01', g: 'y', k: 'q' },
  ],
}
const NULLS = {
  values: [
    { a: 'A', b: 28, c: 3 },
    { a: 'B', b: null, c: 7 },
    { a: 'C', b: 43, c: null },
    { a: 'A', b: 91, c: 9 },
    { a: 'B', b: 12, c: 4 },
  ],
}
const q = (field: string, extra: Spec = {}): Spec => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Spec = {}): Spec => ({ field, type: 'nominal', ...extra })
const t = (field: string, extra: Spec = {}): Spec => ({ field, type: 'temporal', ...extra })

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const deepFreeze = <T,>(v: T): T => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}
const oracleOf = (spec: Spec): Spec => (vl as unknown as { compile: (s: unknown) => { spec: Spec } }).compile(plain(spec)).spec
const oursOf = (spec: Spec): Spec => compile(deepFreeze(plain(spec)) as never) as Spec

/** The leaf items of every mark of the spec's own (not the guides), as the scenegraph holds them. */
function itemCount(vgSpecRender: string): number {
  return (vgSpecRender.match(/role="graphics-symbol"|role="graphics-object"/g) ?? []).length
}

/** Both compilers' Vega, run by vega: no new error or warning, the same canonical SVG, the same number of drawn items. */
async function same(spec: Spec): Promise<void> {
  const oracle = oracleOf(spec)
  const ours = oursOf(spec)
  const [ref, mine] = await Promise.all([renderWithVegaChecked(oracle), renderWithVegaChecked(plain(ours))])
  const inherited = new Set([...ref.errors, ...ref.warnings])
  expect([...mine.errors, ...mine.warnings].filter((m) => !inherited.has(m))).toEqual([])
  expect(itemCount(mine.svg), 'drawn items').toBe(itemCount(ref.svg))
  expect(diffCanonical(canonicalizeSvg(ref.svg), canonicalizeSvg(mine.svg)).slice(0, 2)).toEqual([])
}

/** A spec vega-lite itself cannot compile or run: Aster refuses it with a typed error (decision Q9) rather than drawing a wrong chart. */
async function refusedAsVegaLiteFails(spec: Spec, message: RegExp): Promise<void> {
  let upstream: unknown
  try {
    const oracle = oracleOf(spec)
    const r = await renderWithVegaChecked(oracle)
    if (r.errors.length === 0) throw new Error('vega-lite compiled it and vega ran it')
    upstream = r.errors
  } catch (e) {
    if (e instanceof Error && e.message === 'vega-lite compiled it and vega ran it') throw e
    upstream = e
  }
  expect(upstream).toBeDefined()
  expect(() => oursOf(spec)).toThrow(message)
}

const MARK_NAMES = ['point', 'circle', 'square', 'tick', 'bar', 'rect', 'line', 'area', 'trail', 'rule', 'text'] as const

// compile/mark/mark.ts getStackGroup: the stack of a rounded bar is a group faceted by its dimension, and the group inside it has no
// `from` of its own. A facet gives every mark the cell's dataset, but not that inner group: it is instanced by the outer one's items.
describe('@aster-charts/vl == vega-lite: a rounded stacked bar inside a facet (C55)', () => {
  const bar = (extra: Spec): Spec => ({ data: DATA, mark: { type: 'bar', cornerRadius: 6, opacity: 0.5 }, ...extra })
  const enc = { x: n('g'), y: q('b'), color: n('k') }
  const CASES: Array<[string, Spec]> = [
    ['column', bar({ encoding: { ...enc, column: n('a') } })],
    ['row', bar({ encoding: { ...enc, row: n('a') } })],
    ['row and column', bar({ encoding: { ...enc, row: n('a'), column: n('g') } })],
    ['the facet encoding channel', bar({ encoding: { ...enc, facet: n('a', { columns: 2 }) } })],
    ['the facet operator', { data: DATA, facet: { column: n('a') }, spec: { mark: { type: 'bar', cornerRadius: 6, opacity: 0.5 }, encoding: enc } }],
    ['the facet operator, wrapped', { data: DATA, facet: n('a'), columns: 2, spec: { mark: { type: 'bar', cornerRadius: 6, opacity: 0.5 }, encoding: enc } }],
    ['horizontal', bar({ encoding: { y: n('g'), x: q('b'), color: n('k'), column: n('a') } })],
    ['cornerRadiusEnd', { data: DATA, mark: { type: 'bar', cornerRadiusEnd: 6, opacity: 0.5 }, encoding: { ...enc, column: n('a') } }],
    ['a layer in a facet', { data: DATA, facet: { column: n('a') }, spec: { layer: [{ mark: { type: 'bar', cornerRadius: 6, opacity: 0.5 }, encoding: enc }, { mark: 'text', encoding: { x: n('g'), y: q('b'), text: q('b') } }] } }],
  ]
  for (const [name, spec] of CASES) it(name, () => same(spec), 30_000)
})


// compile/common.ts getMarkPropOrConfig / getMarkConfig and config.ts stripAndRedirectConfig (C80, C297, C298): every mark property a
// mark def, `config.<mark>`, `config.mark`, `config.style.<mark>` or a named style (`mark.style`) can give, on every mark type. Where
// vega-lite and Aster differ the drawings differ, so a property that is not applied - or applied from the wrong place of the
// precedence (mark def, style, mark config, config.mark; a Vega channel's own rules for a line's, a rule's and a text's size) - fails.
describe('@aster-charts/vl == vega-lite: mark properties from the mark def, the styles and the config (every mark, property and place)', () => {
  // each mark over the encodings that give it a different layout: a band and a continuous axis, both continuous, a time unit
  const BASE: Record<string, Spec[]> = {
    point: [{ x: q('c'), y: q('b') }], circle: [{ x: q('c'), y: q('b') }], square: [{ x: q('c'), y: q('b') }],
    tick: [{ x: q('b'), y: n('a') }, { x: n('a'), y: q('b') }, { x: q('c'), y: q('b') }],
    bar: [{ x: n('a'), y: q('b') }, { x: q('b'), y: n('a') }, { x: q('c'), y: q('b') }, { x: t('d'), y: q('b') }],
    rect: [{ x: n('a'), y: n('g'), color: q('b') }, { x: q('c'), y: q('b') }, { x: q('b'), y: n('a') }],
    line: [{ x: t('d'), y: q('b') }], area: [{ x: t('d'), y: q('b') }, { y: t('d'), x: q('b') }], trail: [{ x: t('d'), y: q('b') }],
    rule: [{ y: q('b') }, { x: q('c') }, { x: q('c'), y: q('b') }],
    text: [{ x: n('a'), y: q('b'), text: n('g') }], arc: [{ theta: q('b'), color: n('a') }],
    image: [{ x: q('c'), y: q('b'), url: { value: 'data:image/png;base64,iVBORw0KGgo=' } }],
  }
  const PROPS: Record<string, unknown> = {
    opacity: 0.4, fillOpacity: 0.3, strokeOpacity: 0.3, strokeWidth: 4, strokeDash: [3, 2], strokeCap: 'round', strokeJoin: 'bevel', strokeMiterLimit: 3,
    strokeDashOffset: 2, cornerRadius: 5, cornerRadiusTopLeft: 4, angle: 30, blend: 'multiply', font: 'serif', fontSize: 17, fontStyle: 'italic',
    fontWeight: 'bold', dx: 3, dy: 4, limit: 50, size: 77, shape: 'diamond', width: 9, height: 8, align: 'left', baseline: 'top', description: 'hello',
    aria: false, tension: 0.5, interpolate: 'monotone', lineHeight: 20, radius: 70, radius2: 20, innerRadius: 30, outerRadius: 70, padAngle: 0.1,
    cursor: 'help', color: 'red', fill: 'green', stroke: 'blue', filled: true, theta: 1, ariaRole: 'img', ariaRoleDescription: 'xyz', orient: 'horizontal',
    thickness: 3, discreteBandSize: 7, continuousBandSize: 11, xOffset: 5, yOffset: 6, x: 50, y: 40, x2: 90, y2: 20,
  }
  const PLACES: Record<string, (m: string, p: string, v: unknown) => Spec> = {
    'the mark def': (m, p, v) => ({ mark: { type: m, [p]: v } }),
    'config.<mark>': (m, p, v) => ({ mark: m, config: { [m]: { [p]: v } } }),
    'config.mark': (m, p, v) => ({ mark: m, config: { mark: { [p]: v } } }),
    'config.style.<mark>': (m, p, v) => ({ mark: m, config: { style: { [m]: { [p]: v } } } }),
    'a named style': (m, p, v) => ({ mark: { type: m, style: 'zz' }, config: { style: { zz: { [p]: v } } } }),
  }
  const refusedBySchema = (e: unknown): boolean => e instanceof Error && /\(Vega-Lite [\d.]+ schema\)$/.test(e.message)
  for (const [m, encodings] of Object.entries(BASE)) {
    it(m, async () => {
      const failures: string[] = []
      let compared = 0
      for (const [p, v] of Object.entries(PROPS)) {
        for (const [place, make] of Object.entries(PLACES)) for (const [shape, encoding] of encodings.entries()) {
          const spec: Spec = { data: DATA, encoding, ...make(m, p, v) }
          let oracle: Spec
          try { oracle = oracleOf(spec) } catch { continue }
          let ours: Spec
          try { ours = oursOf(spec) } catch (e) {
            if (!refusedBySchema(e)) failures.push(`${m}#${shape} ${p} in ${place}: refused: ${(e as Error).message.slice(0, 120)}`)
            continue
          }
          let ref: string, mine: string
          try { ref = await renderWithVega(oracle) } catch { continue }
          try { mine = await renderWithVega(plain(ours)) } catch (e) { failures.push(`${m}#${shape} ${p} in ${place}: vega fails: ${(e as Error).message.slice(0, 100)}`); continue }
          compared++
          const diff = diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine)).slice(0, 1)
          if (diff.length) failures.push(`${m}#${shape} ${p} in ${place}: ${diff[0]}`)
        }
      }
      expect(compared).toBeGreaterThan(100)
      expect(failures).toEqual([])
    }, 300_000)
  }
})

// compile/mark/encode/tooltip.ts and aria.ts: the titles of the fields are text in an expression; a quote, a backslash or a line break in
// one must stay text (C103). Vega-Lite 6.4.3 writes them with only the quote escaped and the chart fails to run, so the comparison is
// with the title itself: the chart runs, and the description and the tooltip name the fields by their titles, whatever characters they hold.
describe('@aster-charts/vl: a title with a quote, a backslash or a line break stays text in the description and the tooltip (C103)', () => {
  const TITLES = ['line1\nline2', 'back\\slash', 'trailing\\', 'say "hi"', 'it\'s', 'a\\"b', 'tab\there', '\u2028sep', '${x}', '`tick`', '</script>', 'ünï ☃']
  for (const title of TITLES) {
    for (const mark of ['bar', 'point', 'line', 'text', 'rect', 'tick'] as const) {
      it(`${mark}: ${JSON.stringify(title)}`, async () => {
        const encoding: Spec = mark === 'rect' ? { x: n('a', { title }), y: n('g'), color: q('b', { title }) } : { x: n('a', { title }), y: q('b', { title: `${title}!` }), ...(mark === 'text' ? { text: q('b') } : {}), tooltip: [n('a', { title }), q('b', { title })] }
        const r = await renderWithVegaChecked(plain(oursOf({ data: DATA, mark, encoding })))
        expect(r.errors).toEqual([])
        // (every item has its description, `<title>: <value>; ...`, and a tooltip object keyed by the titles)
        const described = [...r.svg.matchAll(/aria-label="([^"]*)"/g)].length
        expect(described).toBeGreaterThan(0)
        if (mark !== 'rect') expect(r.tooltips.length).toBeGreaterThan(0)
        for (const tip of r.tooltips) expect(tip.includes(`: {${JSON.stringify(title)}:`), tip).toBe(true)
      }, 30_000)
    }
  }
})

// compile/invalid/*, mark/encode/invalid.ts, data/filterinvalid.ts (C178, C434): each channel has its own invalid-value handling, even where
// several channels read one field; a binned field is tested by its bin's start, as it is read
describe('@aster-charts/vl == vega-lite: invalid values per channel, a field on several channels (C178, C434)', () => {
  const MODES: Array<string | null | undefined> = [undefined, 'show', 'filter', 'break-paths-show-domains', 'break-paths-filter-domains', null]
  const ENCODINGS: Record<string, Spec> = {
    'y and the colour share a field': { x: q('c'), y: q('b'), color: q('b') },
    'x and the size share a field': { x: q('c'), y: q('b'), size: q('c') },
    'y, the opacity and the size share a field': { x: q('c'), y: q('b'), opacity: q('b'), size: q('b') },
    'a binned x': { x: q('b', { bin: true }), y: { aggregate: 'count' } },
    'a binned x with a colour on the field': { x: q('b', { bin: true }), y: q('c'), color: q('b') },
    'one field on x and y': { x: q('b'), y: q('b') },
  }
  const SCALE_INVALID: Record<string, Spec | undefined> = {
    'no config.scale.invalid': undefined,
    'config.scale.invalid on the colour': { color: { value: 'red' } },
    'config.scale.invalid on the size': { size: { value: 20 } },
    'config.scale.invalid on y': { y: { value: 5 } },
  }
  for (const mark of ['point', 'circle', 'square', 'text', 'tick', 'rule', 'line', 'area', 'trail', 'bar'] as const) {
    it(mark, async () => {
      const failures: string[] = []
      let compared = 0
      for (const [encName, encoding] of Object.entries(ENCODINGS)) {
        for (const mode of MODES) {
          for (const [cfgName, invalid] of Object.entries(SCALE_INVALID)) {
            const enc: Spec = mark === 'text' ? { ...encoding, text: n('a') } : encoding
            const spec: Spec = { data: NULLS, mark: mode === undefined ? mark : { type: mark, invalid: mode }, encoding: enc, ...(invalid ? { config: { scale: { invalid } } } : {}) }
            let oracle: Spec
            try { oracle = oracleOf(spec) } catch { continue }
            let ours: Spec
            try { ours = oursOf(spec) } catch (e) { failures.push(`${encName} / ${String(mode)} / ${cfgName}: refused ${(e as Error).message.slice(0, 100)}`); continue }
            let ref: string, mine: string
            try { ref = await renderWithVega(oracle) } catch { continue }
            try { mine = await renderWithVega(plain(ours)) } catch (e) { failures.push(`${encName} / ${String(mode)} / ${cfgName}: vega fails ${(e as Error).message.slice(0, 80)}`); continue }
            compared++
            const diff = diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine)).slice(0, 1)
            if (diff.length) failures.push(`${encName} / ${String(mode)} / ${cfgName}: ${diff[0]}`)
          }
        }
      }
      expect(compared).toBeGreaterThan(50)
      expect(failures).toEqual([])
    }, 300_000)
  }
})

// compile/mark/encode/text.ts + tooltip.ts + valueref.ts formatSignalRef (C179): the format of a field that comes from a condition is the
// condition's own
describe('@aster-charts/vl == vega-lite: the format of a conditional field of text, tooltip and href (C179)', () => {
  const COND = 'datum.b > 40'
  const FORMATS: Array<[string, Spec]> = [
    ['a number format', { field: 'b', type: 'quantitative', format: '.2f' }],
    ['a percent format', { field: 'b', type: 'quantitative', format: '.1%' }],
    ['a time format', { field: 'd', type: 'temporal', format: '%Y' }],
    ['a time unit with a format', { field: 'd', type: 'temporal', timeUnit: 'month', format: '%B' }],
    ['a format type', { field: 'd', type: 'temporal', format: '%b', formatType: 'time' }],
    ['no format', { field: 'b', type: 'quantitative' }],
    ['a binned field with a format', { field: 'b', type: 'quantitative', bin: true, format: '.1f' }],
  ]
  for (const [name, def] of FORMATS) {
    for (const channel of ['text', 'tooltip'] as const) {
      it(`${channel}: ${name}`, async () => {
        const encoding: Spec = { x: n('a'), y: q('b'), [channel]: { condition: { test: COND, ...def }, value: '-' } }
        const spec: Spec = { data: DATA, mark: channel === 'text' ? 'text' : 'bar', encoding }
        const oracle = oracleOf(spec)
        const [ref, mine] = await Promise.all([renderWithVegaChecked(oracle), renderWithVegaChecked(plain(oursOf(spec)))])
        expect(mine.errors).toEqual(ref.errors)
        expect(mine.tooltips).toEqual(ref.tooltips)
        expect(diffCanonical(canonicalizeSvg(ref.svg), canonicalizeSvg(mine.svg)).slice(0, 2)).toEqual([])
      }, 30_000)
    }
  }
})

// axis/properties.ts defaultLabelAlign / defaultLabelBaseline (C226): an axis orient given as an expression drives the label's align and
// baseline as a signal, so the labels follow it as the parameter changes
describe('@aster-charts/vl == vega-lite: axis labels follow an orient that is an expression (C226)', () => {
  const ORIENTS = { x: ['bottom', 'top'], y: ['left', 'right'] } as const
  const ANGLES: Array<number | undefined> = [undefined, 0, 45, 90, 270, 315]
  for (const ch of ['x', 'y'] as const) {
    for (const angle of ANGLES) {
      it(`${ch} axis, labelAngle ${angle ?? 'default'}`, async () => {
        const axis: Spec = { orient: { expr: `${ch}Orient` }, ...(angle === undefined ? {} : { labelAngle: angle }) }
        const spec: Spec = {
          data: DATA,
          params: [{ name: `${ch}Orient`, value: ORIENTS[ch][0], bind: { input: 'select', options: [...ORIENTS[ch]] } }],
          mark: 'bar',
          encoding: ch === 'x' ? { x: n('a', { axis }), y: q('b') } : { y: n('a', { axis }), x: q('b') },
        }
        const oracle = oracleOf(spec)
        const ours = plain(oursOf(spec))
        for (const value of ORIENTS[ch]) {
          const draw = async (vg: Spec): Promise<string> => {
            const view = new vega.View(vega.parse(vg as never), { renderer: 'none' })
            try {
              view.signal(`${ch}Orient`, value)
              await view.runAsync()
              view.finalize()
              return await view.toSVG()
            } finally { view.finalize() }
          }
          const [ref, mine] = [await draw(oracle), await draw(ours)]
          expect(diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine)).slice(0, 2), `${ch}Orient = ${value}`).toEqual([])
        }
      }, 30_000)
    }
  }
})

// mark/mark.ts scaleClip (C435): only a position scale bound to a selection clips the marks
describe('@aster-charts/vl == vega-lite: which marks a scale bound to a selection clips (C435)', () => {
  const clips = (vg: Spec): boolean[] => {
    const out: boolean[] = []
    const walk = (ms: Spec[] | undefined): void => { for (const m of ms ?? []) { if (m.role !== 'axis' && m.type !== 'group') out.push(m.clip === true); walk(m.marks) } }
    walk(vg.marks)
    return out
  }
  const bound = (channel: string, extra: Spec = {}): Spec => ({
    data: DATA,
    vconcat: [
      { params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] }, value: { x: [2, 6] } }], mark: 'point', encoding: { x: q('c'), y: q('b') } },
      { mark: 'point', encoding: { x: q('b'), y: n('a'), [channel]: { ...q('c'), scale: { domain: { param: 'brush' } } } , ...extra } },
    ],
  })
  for (const channel of ['color', 'size', 'opacity', 'strokeWidth', 'fill', 'stroke', 'angle', 'fillOpacity', 'strokeOpacity']) {
    it(`the ${channel} scale`, () => {
      expect(clips(oursOf(bound(channel)))).toEqual(clips(oracleOf(bound(channel))))
    })
  }
  for (const channel of ['x', 'y']) {
    it(`the ${channel} scale`, () => {
      const spec: Spec = { data: DATA, vconcat: [
        { params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] }, value: { x: [2, 6] } }], mark: 'point', encoding: { x: q('c'), y: q('b') } },
        { mark: 'point', encoding: { [channel]: { ...q('b'), scale: { domain: { param: 'brush' } } }, [channel === 'x' ? 'y' : 'x']: q('c') } },
      ] }
      expect(clips(oursOf(spec))).toEqual(clips(oracleOf(spec)))
      expect(clips(oursOf(spec)).includes(true)).toBe(true)
    })
  }
})

// scale/range.ts getOffsetRange (C636)
describe('@aster-charts/vl: an offset over a point scale is refused as vega-lite refuses it (C636)', () => {
  for (const mark of ['bar', 'point', 'tick', 'circle', 'text'] as const) {
    for (const offset of ['xOffset', 'yOffset'] as const) {
      it(`${mark} ${offset}`, () => {
        const pos = offset === 'xOffset' ? 'x' : 'y'
        const other = pos === 'x' ? 'y' : 'x'
        const spec: Spec = { data: DATA, mark, encoding: { [pos]: n('a', { scale: { type: 'point' } }), [other]: q('b'), [offset]: n('g'), ...(mark === 'text' ? { text: n('g') } : {}) } }
        expect(() => oracleOf(spec)).toThrow(/is not discrete/)
        expect(() => oursOf(spec)).toThrow(/point scale has no band/)
      })
    }
  }
})

const POSITIONS: Record<string, Spec | undefined> = {
  none: undefined,
  nominal: n('a'),
  quantitative: q('b'),
  'binned quantitative': q('b', { bin: true }),
  temporal: t('d'),
  'time unit': t('d', { timeUnit: 'month' }),
  'binned ordinal': { field: 'b', type: 'ordinal', bin: true },
}

/** Every pair of position definitions over `marks`, `extra` added to the encoding: the two drawings must agree (or both compilers refuse). */
function overPositionPairs(marks: Array<string | Spec>, extra: Spec, positions: Record<string, Spec | undefined> = POSITIONS): void {
  for (const mark of marks) {
    const name = typeof mark === 'string' ? mark : String(mark.type)
    it(name, async () => {
      const failures: string[] = []
      let compared = 0
      for (const [xn, x] of Object.entries(positions)) {
        for (const [yn, y] of Object.entries(positions)) {
          const spec: Spec = { data: DATA, mark, encoding: { ...(x ? { x } : {}), ...(y ? { y } : {}), ...extra } }
          let oracle: Spec
          try { oracle = oracleOf(spec) } catch { continue }
          let ours: Spec
          try { ours = oursOf(spec) } catch (e) { failures.push(`x ${xn} / y ${yn}: refused ${(e as Error).message.slice(0, 100)}`); continue }
          let ref: string, mine: string
          try { ref = await renderWithVega(oracle) } catch { continue }
          try { mine = await renderWithVega(plain(ours)) } catch (e) { failures.push(`x ${xn} / y ${yn}: vega fails ${(e as Error).message.slice(0, 80)}`); continue }
          compared++
          const diff = diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine)).slice(0, 1)
          if (diff.length) failures.push(`x ${xn} / y ${yn}: ${diff[0]}`)
        }
      }
      expect(compared).toBeGreaterThan(5)
      expect(failures).toEqual([])
    }, 300_000)
  }
}

// position-rect.ts rectPosition (C436): a constant position of a bar, tick or rule is a band only where the encoding gives the mark an
// orientation; any other is a range from the constant to the edge
describe('@aster-charts/vl == vega-lite: a constant position of a bar, a tick, a rule or a rect, over every other position (C436)', () => {
  for (const ch of ['x', 'y'] as const) {
    describe(`a constant ${ch}`, () => {
      const others: Record<string, Spec | undefined> = {}
      for (const [k, v] of Object.entries(POSITIONS)) others[k] = v
      for (const mark of ['bar', 'tick', 'rule', 'rect', 'point', 'line'] as const) {
        it(mark, async () => {
          const failures: string[] = []
          let compared = 0
          for (const [on, other] of Object.entries(others)) {
            for (const value of [33, 120]) {
              const spec: Spec = { data: DATA, mark, encoding: { [ch]: { value }, ...(other ? { [ch === 'x' ? 'y' : 'x']: other } : {}) } }
              let oracle: Spec
              try { oracle = oracleOf(spec) } catch { continue }
              let ours: Spec
              try { ours = oursOf(spec) } catch (e) { failures.push(`${on} / ${value}: refused ${(e as Error).message.slice(0, 100)}`); continue }
              let ref: string, mine: string
              try { ref = await renderWithVega(oracle) } catch { continue }
              try { mine = await renderWithVega(plain(ours)) } catch (e) { failures.push(`${on} / ${value}: vega fails ${(e as Error).message.slice(0, 80)}`); continue }
              compared++
              const diff = diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine)).slice(0, 1)
              if (diff.length) failures.push(`${on} / ${value}: ${diff[0]}`)
            }
          }
          expect(compared).toBeGreaterThan(5)
          expect(failures).toEqual([])
        }, 300_000)
      }
    })
  }
})

// valueref.ts midPoint + position-rect.ts positionAndSize (C437, C559): where in its band a value sits: a binned field or a time unit on a
// discrete scale is at the band's start; any other at its own bandPosition; a ranged bar's ends too
describe('@aster-charts/vl == vega-lite: band placement of rules, ticks and ranged bars (C437, C559)', () => {
  describe('a rule or a tick over a binned ordinal, a time unit and a band', () => {
    overPositionPairs(['rule', 'tick', 'point', 'circle', 'text'].map((m) => (m === 'text' ? ({ type: 'text' } as Spec) : m)), { ...{} }, {
      'binned ordinal': POSITIONS['binned ordinal'],
      nominal: POSITIONS.nominal,
      'nominal at 0.2': n('a', { bandPosition: 0.2 }),
      'ordinal time unit': { field: 'd', type: 'ordinal', timeUnit: 'month' },
      quantitative: POSITIONS.quantitative,
    })
  })
  describe('a ranged bar with a band position', () => {
    for (const bp of [0, 0.2, 0.5, 1]) {
      for (const dir of ['x', 'y'] as const) {
        it(`${dir} at ${bp}`, async () => {
          const spec: Spec = { data: DATA, mark: 'bar', encoding: { [dir]: n('a', { bandPosition: bp }), [`${dir}2`]: { field: 'c' }, [dir === 'x' ? 'y' : 'x']: q('b') } }
          await same(spec)
        }, 30_000)
      }
    }
  })
})

// position-rect.ts positionAndSize + channeldef.ts getBandSize (C438): the size channel of a bar, a tick and a rect, over every pair of positions
describe('@aster-charts/vl == vega-lite: the size channel of a bar, a tick and a rect, over every pair of positions (C438)', () => {
  overPositionPairs(['bar', 'tick', 'rect'], { size: q('c') })
})

// data/timeunit.ts offsetedRectFormulas (C440): the same time unit of one field on x and y, with a band position on one
describe('@aster-charts/vl == vega-lite: one time unit on x and y with a band position on one (C440)', () => {
  for (const mark of ['bar', 'rect', 'tick'] as const) {
    for (const [bx, by] of [[undefined, 0], [0, undefined], [0.2, 0], [undefined, 1], [0, 0]] as const) {
      it(`${mark}: x ${bx ?? '-'}, y ${by ?? '-'}`, () => same({
        data: DATA,
        mark,
        encoding: {
          x: t('d', { timeUnit: 'yearmonth', ...(bx === undefined ? {} : { bandPosition: bx }) }),
          y: t('d', { timeUnit: 'yearmonth', ...(by === undefined ? {} : { bandPosition: by }) }),
        },
      }), 30_000)
    }
  }
})

// legend/encode.ts (C560): the opacity of an unselected entry of an interactive legend is config.legend.unselectedOpacity
describe('@aster-charts/vl == vega-lite: the opacity of unselected legend entries (C560)', () => {
  const opacities = (vg: Spec): unknown[] => {
    const out: unknown[] = []
    for (const lg of vg.legends ?? []) for (const part of Object.values(lg.encode ?? {}) as Spec[]) {
      const o = part.update?.opacity
      if (o !== undefined) out.push(JSON.stringify(o).replaceAll(/"test":"[^"]*",?/g, ''))
    }
    return out
  }
  for (const unselected of [undefined, 0.9, 0.1, 0]) {
    for (const channel of ['color', 'shape', 'size'] as const) {
      it(`${channel}, unselectedOpacity ${unselected ?? 'default'}`, () => {
        const spec: Spec = {
          data: DATA,
          params: [{ name: 'pick', select: { type: 'point', fields: ['a'] }, bind: 'legend' }],
          mark: 'point',
          encoding: { x: q('c'), y: q('b'), [channel]: channel === 'size' ? q('b') : n('a') },
          ...(unselected === undefined ? {} : { config: { legend: { unselectedOpacity: unselected } } }),
        }
        expect(opacities(oursOf(spec))).toEqual(opacities(oracleOf(spec)))
        expect(opacities(oursOf(spec)).length).toBeGreaterThan(0)
      })
    }
  }
})

// layout/parse.ts + normalize/concat: an hconcat and a vconcat are concats of their views, `align` and all
describe('@aster-charts/vl == vega-lite: align on an hconcat and a vconcat', () => {
  const view = { mark: 'point', encoding: { x: q('c'), y: q('b') } }
  const tall = { mark: 'bar', encoding: { x: n('a'), y: q('b', { aggregate: 'sum' }), color: n('g') } }
  for (const operator of ['hconcat', 'vconcat'] as const) {
    // (the `{row, column}` form too: the schema table's first enumeration, the words of a layout alignment, was dropped from a type that is
    // nothing else, and the form was refused for a plain concat as well)
    for (const align of ['all', 'each', 'none', { row: 'each', column: 'none' }, { row: 'none', column: 'all' }] as const) {
      it(`${operator} align ${JSON.stringify(align)}`, () => same({ data: DATA, [operator]: [view, tall, view], align }), 30_000)
    }
  }
  for (const align of [{ row: 'each', column: 'none' }, { column: 'all' }] as const) {
    it(`concat align ${JSON.stringify(align)}`, () => same({ data: DATA, columns: 2, concat: [view, tall, view], align }), 30_000)
  }
  for (const channel of ['row', 'column'] as const) {
    for (const align of ['all', 'each', 'none'] as const) {
      it(`a ${channel} channel with align ${JSON.stringify(align)}`, () => same({ data: DATA, mark: 'point', encoding: { x: q('c'), y: q('b'), [channel]: { ...n('g'), align } } }), 30_000)
    }
  }
})

// compile/mark/encode/tooltip.ts, aria.ts, axis title, position-rect.ts defaultSizeRef: mark and channel forms vega-lite reads that were refused
describe('@aster-charts/vl == vega-lite: forms of tooltip, aria, title and band size that were refused', () => {
  const CASES: Array<[string, Spec]> = [
    ['mark.tooltip as a number', { data: DATA, mark: { type: 'bar', tooltip: 5 }, encoding: { x: n('a'), y: q('b') } }],
    ['mark.tooltip as true', { data: DATA, mark: { type: 'bar', tooltip: true }, encoding: { x: n('a'), y: q('b') } }],
    ['mark.tooltip as an expression', { data: DATA, mark: { type: 'bar', tooltip: { expr: "'v=' + datum.b" } }, encoding: { x: n('a'), y: q('b') } }],
    ['config.mark.tooltip as a number', { data: DATA, config: { mark: { tooltip: 5 } }, mark: 'bar', encoding: { x: n('a'), y: q('b') } }],
    ['mark.aria as an expression', { data: DATA, params: [{ name: 'p', value: true }], mark: { type: 'bar', aria: { expr: 'p' } }, encoding: { x: n('a'), y: q('b') } }],
    ['an empty axis title list', { data: DATA, mark: 'point', encoding: { x: q('c', { title: [] }), y: q('b') } }],
    ['an empty legend title list', { data: DATA, mark: 'point', encoding: { x: q('c'), y: q('b'), color: n('a', { title: [] }) } }],
    ['a relative bar width over a continuous x and a nominal y', { data: DATA, mark: { type: 'bar', width: { band: 0.5 } }, encoding: { x: q('c'), y: n('a') } }],
    ['a relative bar width over two continuous axes', { data: DATA, mark: { type: 'bar', width: { band: 0.5 } }, encoding: { x: q('c'), y: q('b') } }],
    ['a relative bar height over a continuous y', { data: DATA, mark: { type: 'bar', height: { band: 0.5 } }, encoding: { y: q('c'), x: q('b') } }],
    ['a relative tick width', { data: DATA, mark: { type: 'tick', width: { band: 0.5 } }, encoding: { x: q('c'), y: q('b') } }],
    ['a tick width and height on a nominal axis', { data: DATA, mark: { type: 'tick', width: 9, height: 7 }, encoding: { x: q('b'), y: n('a') } }],
  ]
  for (const [name, spec] of CASES) it(name, async () => {
    const oracle = oracleOf(spec)
    const [ref, mine] = await Promise.all([renderWithVegaChecked(oracle), renderWithVegaChecked(plain(oursOf(spec)))])
    expect(mine.errors).toEqual(ref.errors)
    expect(mine.tooltips).toEqual(ref.tooltips)
    expect(diffCanonical(canonicalizeSvg(ref.svg), canonicalizeSvg(mine.svg)).slice(0, 2)).toEqual([])
  }, 30_000)
  it('an order given as a list is refused: vega-lite reads none of it', () => {
    const spec: Spec = { data: DATA, mark: 'line', encoding: { x: q('c'), y: q('b'), order: [{ field: 'g' }, { field: 'b', sort: 'descending' }] } }
    // (the chart vega-lite draws is the one with no order at all)
    const noOrder: Spec = { data: DATA, mark: 'line', encoding: { x: q('c'), y: q('b') } }
    expect(JSON.stringify(oracleOf(spec).marks)).toContain('"sort":{"field":"x"}')
    expect(JSON.stringify(oracleOf(noOrder).marks)).toContain('"sort":{"field":"x"}')
    expect(() => oursOf(spec)).toThrow(/order given as a list/)
  })
})
