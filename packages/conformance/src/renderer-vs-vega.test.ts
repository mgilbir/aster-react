/**
 * Targeted differentials against the real Vega runtime, judged by the STRICT
 * canonicalizer (normalize.ts). Each block pins one class of renderer defect the
 * strict oracle exposed (audit C38, C44, C45, C46, C48, N1, N2) over the general
 * shape of the problem — every mark type, every paint channel, every axis
 * property — not just the one value that first failed.
 *
 * These run against the built `@aster/core` (the `build` gate precedes `test`).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none' },
  )
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

/** Diffs (empty = identical) between real Vega and Aster for `spec`. */
async function compare(spec: Spec): Promise<string[]> {
  return diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))
}

const FRAME = { width: 120, height: 90, padding: 5, autosize: 'none' }

/** One mark of each type with the encodings it needs, over a 3-row dataset. */
const DATA = [{ name: 't', values: [{ a: 10, b: 20, c: 'u' }, { a: 50, b: 60, c: 'v' }, { a: 90, b: 40, c: 'w' }] }]
const MARKS: Record<string, Record<string, unknown>> = {
  symbol: { x: { field: 'a' }, y: { field: 'b' }, size: { value: 120 }, fill: { value: 'steelblue' }, stroke: { value: '#222' } },
  rect: { x: { field: 'a' }, y: { field: 'b' }, width: { value: 14 }, height: { value: 22 }, fill: { value: 'tomato' }, stroke: { value: '#222' } },
  rule: { x: { field: 'a' }, y: { value: 5 }, y2: { field: 'b' }, stroke: { value: '#222' } },
  text: { x: { field: 'a' }, y: { field: 'b' }, text: { field: 'c' }, fill: { value: 'purple' }, stroke: { value: '#222' } },
  arc: { x: { value: 60 }, y: { value: 45 }, startAngle: { field: 'a', mult: 0.02 }, endAngle: { field: 'b', mult: 0.05 }, innerRadius: { value: 8 }, outerRadius: { value: 30 }, fill: { value: 'teal' }, stroke: { value: '#222' } },
  area: { x: { field: 'a' }, y: { field: 'b' }, y2: { value: 85 }, fill: { value: 'gold' }, stroke: { value: '#222' } },
  line: { x: { field: 'a' }, y: { field: 'b' }, stroke: { value: '#c00' } },
  trail: { x: { field: 'a' }, y: { field: 'b' }, size: { value: 4 }, fill: { value: 'orange' }, stroke: { value: '#222' } },
  path: { x: { value: 30 }, y: { value: 30 }, path: { value: 'M0,0L20,0L10,16Z' }, fill: { value: 'seagreen' }, stroke: { value: '#222' } },
}

function markSpec(type: string, extra: Record<string, unknown> = {}, markProps: Record<string, unknown> = {}): Spec {
  return { ...FRAME, data: DATA, marks: [{ type, from: { data: 't' }, encode: { update: { ...MARKS[type], ...extra } }, ...markProps }] }
}

describe('N1: raw Vega specs get Vega\'s default config', () => {
  // no fill / size / stroke / font encoded: every value comes from the default config
  const BARE: Record<string, Record<string, unknown>> = {
    symbol: { x: { field: 'a' }, y: { field: 'b' } },
    rect: { x: { field: 'a' }, y: { field: 'b' }, width: { value: 14 }, height: { value: 22 } },
    rule: { x: { field: 'a' }, y: { value: 5 }, y2: { field: 'b' } },
    text: { x: { field: 'a' }, y: { field: 'b' }, text: { field: 'c' } },
    arc: { x: { value: 60 }, y: { value: 45 }, startAngle: { value: 0 }, endAngle: { value: 2 }, outerRadius: { value: 30 } },
    area: { x: { field: 'a' }, y: { field: 'b' }, y2: { value: 85 } },
    line: { x: { field: 'a' }, y: { field: 'b' } },
    trail: { x: { field: 'a' }, y: { field: 'b' } },
    path: { x: { value: 30 }, y: { value: 30 }, path: { value: 'M0,0L20,0L10,16Z' } },
  }
  for (const [type, enc] of Object.entries(BARE)) {
    it(`${type} mark with no encoded paint or size matches Vega`, async () => {
      const spec: Spec = { ...FRAME, data: DATA, marks: [{ type, from: { data: 't' }, encode: { update: enc } }] }
      expect(await compare(spec)).toEqual([])
    })
  }

  it('the default symbol is size 64 filled #4c78a8 (the repro from the audit)', async () => {
    const spec: Spec = { width: 50, height: 50, padding: 0, autosize: 'none', marks: [{ type: 'symbol', encode: { update: { x: { value: 10 }, y: { value: 10 } } } }] }
    const svg = renderSpec(spec as never)
    expect(svg).toContain('fill="#4c78a8"')
    expect(svg).toContain('d="M4,0A4,4,') // r = sqrt(64)/2 = 4
    expect(await compare(spec)).toEqual([])
  })

  it('a user config block overrides one key without dropping the rest of the default block', async () => {
    const spec: Spec = { ...FRAME, config: { symbol: { fill: 'crimson' } }, data: DATA, marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: MARKS.symbol && { x: { field: 'a' }, y: { field: 'b' } } } }] }
    expect(await compare(spec)).toEqual([])
    expect(renderSpec(spec as never)).toContain('fill="crimson"')
  })

  it('an explicit style on a mark beats config.symbol which beats nothing', async () => {
    const spec: Spec = { ...FRAME, config: { style: { dot: { size: 300, fill: 'green' } } }, data: DATA, marks: [{ type: 'symbol', style: 'dot', from: { data: 't' }, encode: { update: { x: { field: 'a' }, y: { field: 'b' } } } }] }
    expect(await compare(spec)).toEqual([])
  })
})

describe('N2: custom SVG path strings as symbol shapes', () => {
  const SHAPES = [
    'M-1,-1L1,1L-1,1Z',
    'M0,-1A1,1,0,1,1,0,1A1,1,0,1,1,0,-1Z',
    'm-1,-1 2,0 0,2 -2,0z',
    'M-1,-1h2v2h-2z',
    'M-1,0 Q0,-2 1,0 T3,0',
    'M-1,0 C-1,-2 1,-2 1,0 S1,2 -1,2',
    'M-1,-1 l2,2 l-2,0 z',
    'M0,-1 a1,2,30,0,1,1,1',
  ]
  for (const shape of SHAPES) {
    it(`shape ${shape}`, async () => {
      expect(await compare(markSpec('symbol', { shape: { value: shape }, size: { value: 400 } }))).toEqual([])
    })
  }

  it('refuses an invalid path the way Vega does, and writes nothing of it', async () => {
    const spec = markSpec('symbol', { shape: { value: 'M0,0L1,1" onload="alert(1)' } })
    await expect(oracleSvg(spec)).rejects.toThrow(/Invalid SVG path/)
    expect(() => renderSpec(spec as never)).toThrow(/Invalid SVG path/)
  })

  it('a path that parses is re-serialized from numbers: no input text reaches the document', () => {
    const svg = renderSpec(markSpec('symbol', { shape: { value: 'M0,0L1,1z' + '<img src=x onerror=alert(1)>'.replace(/[mlhvzcsqta]/gi, '') } }) as never)
    expect(svg).not.toMatch(/onerror|<img/)
  })
})

describe('C48/C38: every paint channel reaches every mark kind', () => {
  const CHANNEL_VALUES: Array<[string, unknown[]]> = [
    ['opacity', [0.4, 0]],
    ['fillOpacity', [0.3]],
    ['strokeOpacity', [0.5, 0]],
    ['strokeWidth', [3]],
    ['strokeCap', ['round', 'square']],
    ['strokeJoin', ['round', 'bevel']],
    ['strokeMiterLimit', [2]],
    ['strokeDash', [[4, 2]]],
    ['strokeDashOffset', [3]],
  ]
  for (const type of Object.keys(MARKS)) {
    for (const [channel, values] of CHANNEL_VALUES) {
      for (const v of values) {
        it(`${type}.${channel}=${JSON.stringify(v)}`, async () => {
          expect(await compare(markSpec(type, { [channel]: { value: v } }))).toEqual([])
        })
      }
    }
  }

  it('mix-blend-mode reaches the markup', async () => {
    expect(await compare(markSpec('rect', { blend: { value: 'multiply' } }))).toEqual([])
  })

  it('frame (root group) paint: fill, stroke, opacity, dash, cap, join, miterlimit', async () => {
    const spec: Spec = {
      ...FRAME, style: 'f',
      config: { style: { f: { fill: '#eef', fillOpacity: 0.5, stroke: '#a00', strokeOpacity: 0.4, strokeWidth: 2, strokeCap: 'round', strokeJoin: 'bevel', strokeMiterLimit: 3, strokeDash: [5, 3], strokeDashOffset: 2, opacity: 0.9 } } },
      data: DATA, marks: [],
    }
    expect(await compare(spec)).toEqual([])
  })
})

describe('C44: text', () => {
  const T = (extra: Record<string, unknown>): Spec => markSpec('text', extra)
  const CASES: Array<[string, Record<string, unknown>]> = [
    ['no align (Vega: start)', {}],
    ['align left', { align: { value: 'left' } }],
    ['align center', { align: { value: 'center' } }],
    ['align right', { align: { value: 'right' } }],
    ['angle 30', { angle: { value: 30 } }],
    ['angle -90 with baseline middle', { angle: { value: -90 }, baseline: { value: 'middle' } }],
    ['angle with dx/dy and baseline top', { angle: { value: 45 }, dx: { value: 3 }, dy: { value: 4 }, baseline: { value: 'top' } }],
    ['baseline top/bottom/middle', { baseline: { value: 'bottom' } }],
    ['baseline line-top', { baseline: { value: 'line-top' } }],
    ['dx/dy unrotated', { dx: { value: 5 }, dy: { value: -2 } }],
    ['font family size weight style variant', { font: { value: 'Courier' }, fontSize: { value: 14 }, fontWeight: { value: 'bold' }, fontStyle: { value: 'italic' }, fontVariant: { value: 'small-caps' } }],
    ['limit truncation', { limit: { value: 6 } }],
    ['multi-line text array', { text: { value: ['first', 'second'] } }],
    ['lineBreak', { text: { value: 'a|b|c' }, lineBreak: { value: '|' } }],
    ['polar anchor (radius/theta)', { radius: { value: 20 }, theta: { value: 1.2 } }],
    ['stroked text', { stroke: { value: '#000' }, strokeWidth: { value: 1 } }],
    ['opacity 0 text is kept as a record', { opacity: { value: 0 } }],
  ]
  for (const [name, extra] of CASES) {
    it(name, async () => expect(await compare(T(extra))).toEqual([]))
  }

  it('never emits a bogus `angle` attribute', () => {
    expect(renderSpec(T({ angle: { value: 30 } }) as never)).not.toMatch(/\sangle=/)
  })
})

describe('C46: area bounds include the baseline', () => {
  it('an area whose baseline lies far below its top edge grows the view like Vega', async () => {
    const spec: Spec = {
      width: 100, height: 100, padding: 5, autosize: 'pad',
      data: [{ name: 't', values: [{ x: 0, y: 20 }, { x: 50, y: 40 }, { x: 100, y: 10 }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: 'width' }],
      marks: [{ type: 'area', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { field: 'y' }, y2: { value: 180 }, fill: { value: 'steelblue' } } } }],
    }
    const size = (svg: string): string => /<svg[^>]*width="([^"]*)" height="([^"]*)"/.exec(svg)!.slice(1).join('x')
    expect(size(renderSpec(spec as never))).toBe(size(await oracleSvg(spec)))
    expect(await compare(spec)).toEqual([])
  })

  it('a horizontal area likewise', async () => {
    const spec: Spec = {
      width: 100, height: 100, padding: 5, autosize: 'pad',
      data: [{ name: 't', values: [{ y: 0, x: 20 }, { y: 50, x: 40 }, { y: 100, x: 10 }] }],
      scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
      marks: [{ type: 'area', from: { data: 't' }, encode: { update: { orient: { value: 'horizontal' }, y: { scale: 'y', field: 'y' }, x: { field: 'x' }, x2: { value: 190 }, fill: { value: 'steelblue' } } } }],
    }
    expect(await compare(spec)).toEqual([])
  })
})

describe('C45: ids are deterministic per render and cannot collide across charts', () => {
  const clipSpec = (w: number, h: number): Spec => ({
    width: w, height: h, padding: 5, autosize: 'none',
    data: DATA,
    marks: [{ type: 'rect', clip: true, from: { data: 't' }, encode: { update: { x: { field: 'a' }, y: { field: 'b' }, width: { value: 14 }, height: { value: 22 }, fill: { value: 'tomato' } } } }],
  })
  const ids = (svg: string): string[] => [...svg.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]!)

  it('rendering the same chart twice yields identical markup', () => {
    expect(renderSpec(clipSpec(100, 80) as never)).toBe(renderSpec(clipSpec(100, 80) as never))
  })

  it('two charts with different clip geometry use different ids', () => {
    const a = ids(renderSpec(clipSpec(400, 300) as never))
    const b = ids(renderSpec(clipSpec(20, 20) as never))
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    for (const id of a) expect(b).not.toContain(id)
  })

  it('every clip-path reference resolves to a clipPath in the same document', () => {
    const svg = renderSpec(clipSpec(100, 80) as never)
    const refs = [...svg.matchAll(/clip-path="url\(#([^)]+)\)"/g)].map((m) => m[1]!)
    expect(refs.length).toBeGreaterThan(0)
    for (const r of refs) expect(ids(svg)).toContain(r)
  })

  const SCHEMES = ['viridis', 'plasma', 'inferno', 'magma']
  const gradientSpec = (n: number): Spec => ({
    width: 100, height: 60, padding: 5, autosize: 'pad',
    data: [{ name: 't', values: [{ v: 0 }, { v: 10 }] }],
    scales: [{ name: 'c', type: 'linear', domain: [0, 10], range: { scheme: SCHEMES[n % 4]! }, zero: false }],
    legends: [{ fill: 'c', type: 'gradient', gradientLength: 100 }],
    marks: [],
  })
  const gradientIds = (svg: string): string[] => [...svg.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]!)

  it('gradient ids do not depend on how many gradients were rendered before', () => {
    const first = gradientIds(renderSpec(gradientSpec(0) as never))
    renderSpec(gradientSpec(1) as never)
    renderSpec(gradientSpec(2) as never)
    expect(gradientIds(renderSpec(gradientSpec(0) as never))).toEqual(first)
  })

  it('different gradients get different ids', () => {
    const a = gradientIds(renderSpec(gradientSpec(0) as never))
    const b = gradientIds(renderSpec(gradientSpec(1) as never))
    expect(a.length).toBeGreaterThan(0)
    expect(a[0]).not.toBe(b[0])
  })

  it('the output matches Vega under the strict oracle', async () => {
    expect(await compare(clipSpec(100, 80))).toEqual([])
    for (let n = 0; n < 4; n++) expect(await compare(gradientSpec(n))).toEqual([])
  })
})

describe('C38: axis guide properties', () => {
  const axisSpec = (props: Record<string, unknown>, config?: Record<string, unknown>): Spec => ({
    ...FRAME, width: 160, height: 100, padding: 5,
    ...(config ? { config: { axis: props } } : {}),
    data: [{ name: 't', values: [{ c: 'alpha', v: 28 }, { c: 'beta', v: 55 }, { c: 'gamma', v: 43 }] }],
    scales: [
      { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
      { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true },
    ],
    axes: [
      { orient: 'bottom', scale: 'x', title: 'category', grid: true, ...(config ? {} : props) },
      { orient: 'left', scale: 'y', title: 'amount', grid: true, ...(config ? {} : props) },
    ],
    marks: [],
  })
  const PROPS: Array<[string, unknown[]]> = [
    ['tickOpacity', [0.3, 0]], ['tickCap', ['round']], ['tickDashOffset', [2]], ['tickDash', [[3, 2]]],
    ['domainCap', ['square']], ['domainDash', [[4, 2]]], ['domainDashOffset', [2]], ['domainOpacity', [0.5]],
    ['gridOpacity', [0.4]], ['gridCap', ['round']], ['gridDash', [[2, 2]]], ['gridDashOffset', [1]],
    ['labelFontStyle', ['italic']], ['labelFontWeight', ['bold', 300]], ['labelFont', ['Courier']], ['labelOpacity', [0.5]],
    ['titleFontStyle', ['italic']], ['titleFontWeight', ['normal']], ['titleFont', ['serif']],
    ['offset', [8]], ['zindex', [1]],
  ]
  for (const [prop, values] of PROPS) {
    for (const v of values) {
      it(`axis.${prop}=${JSON.stringify(v)}`, async () => expect(await compare(axisSpec({ [prop]: v }))).toEqual([]))
      it(`config.axis.${prop}=${JSON.stringify(v)}`, async () => expect(await compare(axisSpec({ [prop]: v }, {}))).toEqual([]))
    }
  }
})

describe('guide ordering and structure', () => {
  const base = (extra: Record<string, unknown>): Spec => ({
    ...FRAME, width: 160, height: 100,
    data: [{ name: 't', values: [{ c: 'alpha', v: 28, g: 'x' }, { c: 'beta', v: 55, g: 'y' }] }],
    scales: [
      { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
      { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true },
      { name: 'k', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
      { name: 'q', type: 'linear', domain: [3, 17], range: { scheme: 'blues' } },
    ],
    axes: [{ orient: 'bottom', scale: 'x', title: 'c' }, { orient: 'left', scale: 'y', title: 'v' }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { scale: 'k', field: 'g' } } } }],
    ...extra,
  })

  it('symbol legend: background, entries, title last', async () => {
    expect(await compare(base({ legends: [{ fill: 'k', title: 'kind' }] }))).toEqual([])
  })
  it('gradient legend stops are the scale ticks, like vega-functions gradient()', async () => {
    expect(await compare(base({ legends: [{ fill: 'q', type: 'gradient', title: 'q' }] }))).toEqual([])
  })
  it('gradient legend labels hidden by overlap stay in the scene with opacity 0', async () => {
    expect(await compare(base({ legends: [{ fill: 'q', type: 'gradient', gradientLength: 12, title: 'q' }] }))).toEqual([])
  })
  it('side titles on a gradient legend', async () => {
    for (const titleOrient of ['left', 'right']) {
      expect(await compare(base({ legends: [{ fill: 'q', type: 'gradient', titleOrient, title: 'q' }] }))).toEqual([])
    }
  })
  it('legend font properties reach title and labels of every legend kind', async () => {
    const props = { titleFont: 'serif', titleFontStyle: 'italic', titleFontWeight: 'normal', labelFont: 'Courier', labelFontStyle: 'italic', labelFontWeight: 'bold' }
    expect(await compare(base({ legends: [{ fill: 'q', type: 'gradient', title: 'q', ...props }] }))).toEqual([])
    expect(await compare(base({ legends: [{ fill: 'k', title: 'k', ...props }] }))).toEqual([])
  })
  it('legend clipHeight clips the symbols in the entry frame', async () => {
    expect(await compare(base({ legends: [{ fill: 'k', title: 'k', clipHeight: 8 }] }))).toEqual([])
  })
  it('axis zindex puts the axis over the marks, in order', async () => {
    const s = base({})
    ;(s.axes as Array<Record<string, unknown>>)[0]!.zindex = 1
    expect(await compare(s)).toEqual([])
  })
  it('a long axis label truncated by labelLimit collides as its truncated self', async () => {
    const s = base({})
    ;(s.axes as Array<Record<string, unknown>>)[0] = { orient: 'bottom', scale: 'x', labelLimit: 6, labelOverlap: true, labelPadding: 2 }
    expect(await compare(s)).toEqual([])
  })
})

describe('stack keeps the input row order', () => {
  it('stacked bars paint in data order', async () => {
    const spec: Spec = {
      ...FRAME, width: 160, height: 100,
      data: [
        // input order p, r, q within each group; the stack sorts ascending by g (p, q, r) but
        // must write start/end back WITHOUT reordering the rows
        { name: 't', values: [{ k: 'a', g: 'p', v: 3 }, { k: 'a', g: 'r', v: 2 }, { k: 'a', g: 'q', v: 5 }, { k: 'b', g: 'p', v: 4 }, { k: 'b', g: 'r', v: 3 }, { k: 'b', g: 'q', v: 1 }], transform: [{ type: 'stack', groupby: ['k'], field: 'v', sort: { field: 'g' }, as: ['y0', 'y1'] }] },
      ],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.2 },
        { name: 'y', type: 'linear', domain: { data: 't', field: 'y1' }, range: 'height', nice: true },
      ],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'y0' }, y2: { scale: 'y', field: 'y1' }, fill: { value: 'steelblue' }, stroke: { value: '#000' } } } }],
    }
    expect(await compare(spec)).toEqual([])
  })
})
