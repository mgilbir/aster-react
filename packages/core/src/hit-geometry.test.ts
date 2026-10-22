/**
 * Hit-index geometry oracle (audit C47, C41).
 *
 * For every mark type, a point inside the geometry the canvas renderer PAINTS
 * must resolve to that mark's item, and a point well outside everything painted
 * must resolve to nothing. The painted geometry is taken from the canvas
 * renderer itself (a recording context that flattens each fill/stroke path), not
 * from the hit index: arcs, paths, shapes, geoshapes, areas, lines, trails,
 * rounded rects, every symbol shape, rotated symbols. Text is checked against
 * the layout's text box, rotated.
 *
 * Points within the 2px pointing slack of painted geometry are not asserted
 * (either answer is fine there).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { compileChart, evaluateChart } from './index.js'
import { renderSceneToCanvas } from './canvas.js'
import { buildHitIndex } from './hit.js'
import { makeRecorder, type PaintRecord } from './canvas-record.testlib.js'
import { textWidth, fontSize, baselineOffset, lineHeight, textLines } from './bounds.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

// ---------------------------------------------------------------------------
// Independent geometry (the oracle): winding number and distance to a polyline
// ---------------------------------------------------------------------------

type Polys = NonNullable<PaintRecord['polys']>

function winding(polys: Polys, px: number, py: number): number {
  let w = 0
  for (const { pts } of polys) {
    const n = pts.length / 2
    for (let i = 0; i < n; i++) {
      const x0 = pts[2 * i]!, y0 = pts[2 * i + 1]!
      const j = (i + 1) % n
      const x1 = pts[2 * j]!, y1 = pts[2 * j + 1]!
      // crossing of the horizontal ray to +x with the edge, signed by direction
      if ((y0 <= py) !== (y1 <= py)) {
        const xc = x0 + ((py - y0) / (y1 - y0)) * (x1 - x0)
        if (xc > px) w += y1 > y0 ? 1 : -1
      }
    }
  }
  return w
}

function distToPolys(polys: Polys, px: number, py: number, closeAll: boolean): number {
  let best = Infinity
  for (const { pts, closed } of polys) {
    const n = pts.length / 2
    const segs = closed || closeAll ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n
      const ax = pts[2 * i]!, ay = pts[2 * i + 1]!, bx = pts[2 * j]!, by = pts[2 * j + 1]!
      const dx = bx - ax, dy = by - ay
      const l2 = dx * dx + dy * dy
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
      best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    }
    if (n === 1) best = Math.min(best, Math.hypot(px - pts[0]!, py - pts[1]!))
  }
  return best
}

/** 'in': certainly painted; 'out': certainly beyond the pointing slack; 'edge': don't care. */
function classify(records: PaintRecord[], x: number, y: number): 'in' | 'out' | 'edge' {
  const MARGIN = 0.4
  const SLACK_OUT = 2 + 1.5
  let minOut = Infinity
  for (const r of records) {
    if (!r.polys) continue
    if (r.op === 'fill') {
      const d = distToPolys(r.polys, x, y, true)
      if (winding(r.polys, x, y) !== 0) {
        if (d >= MARGIN) return 'in'
        minOut = Math.min(minOut, 0)
      } else minOut = Math.min(minOut, d)
    } else if (r.op === 'stroke') {
      const d = distToPolys(r.polys, x, y, false)
      const half = (r.lineWidth ?? 1) / 2
      if (d <= half - MARGIN) return 'in'
      minOut = Math.min(minOut, Math.max(0, d - half))
    }
  }
  return minOut > SLACK_OUT ? 'out' : 'edge'
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const W = 240
const H = 160
const base = (marks: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json', width: W, height: H, padding: 7, autosize: 'none',
  ...extra, marks,
})
const rowsOf = (n: number, f: (i: number) => Record<string, unknown>): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => f(i))
const dataset = (rows: Record<string, unknown>[]): unknown => [{ name: 't', values: rows }]
const mk = (type: string, update: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ type, from: { data: 't' }, encode: { update }, ...extra })

const SHAPES = ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-right', 'triangle-left', 'wedge', 'arrow', 'triangle']

const SPECS: Record<string, Record<string, unknown>> = {
  'symbol shapes': base([
    mk('symbol', { x: { field: 'x' }, y: { field: 'y' }, size: { value: 700 }, shape: { field: 'shape' }, fill: { value: '#4c78a8' }, stroke: { value: '#222' }, strokeWidth: { value: 2 } }),
  ], { data: dataset(SHAPES.map((shape, i) => ({ shape, x: 28 + (i % 4) * 56, y: 30 + Math.floor(i / 4) * 50 }))) }),
  'rotated symbols': base([
    mk('symbol', { x: { field: 'x' }, y: { value: 80 }, size: { value: 900 }, shape: { value: 'square' }, angle: { field: 'a' }, fill: { value: '#e45756' } }),
  ], { data: dataset([0, 20, 45, 70].map((a, i) => ({ a, x: 30 + i * 55 }))) }),
  'circle marks': base([
    mk('circle', { x: { field: 'x' }, y: { value: 70 }, size: { value: 500 }, fill: { value: '#54a24b' }, stroke: { value: '#000' }, strokeWidth: { value: 3 } }),
  ], { data: dataset(rowsOf(4, (i) => ({ x: 30 + i * 55 }))) }),
  rects: base([
    mk('rect', { x: { field: 'x' }, y: { field: 'y' }, width: { value: 30 }, height: { field: 'h' }, fill: { value: '#4c78a8' } }),
  ], { data: dataset(rowsOf(4, (i) => ({ x: 15 + i * 55, y: 20 + i * 10, h: 60 + i * 10 }))) }),
  'rounded rects': base([
    mk('rect', { x: { field: 'x' }, y: { value: 30 }, width: { value: 40 }, height: { value: 80 }, cornerRadius: { value: 16 }, fill: { value: '#4c78a8' }, stroke: { value: '#000' }, strokeWidth: { value: 2 } }),
  ], { data: dataset(rowsOf(3, (i) => ({ x: 15 + i * 75 }))) }),
  rules: base([
    mk('rule', { x: { field: 'x' }, y: { value: 20 }, x2: { field: 'x2' }, y2: { field: 'y2' }, stroke: { value: '#c33' }, strokeWidth: { value: 3 } }),
  ], { data: dataset(rowsOf(4, (i) => ({ x: 20 + i * 50, x2: 50 + i * 40, y2: 40 + i * 30 }))) }),
  'line (linear)': base([
    mk('line', { x: { field: 'x' }, y: { field: 'y' }, stroke: { value: '#333' }, strokeWidth: { value: 4 } }),
  ], { data: dataset([[10, 120], [60, 30], [110, 100], [160, 40], [220, 90]].map(([x, y]) => ({ x, y }))) }),
  'line (monotone)': base([
    mk('line', { x: { field: 'x' }, y: { field: 'y' }, stroke: { value: '#333' }, strokeWidth: { value: 3 }, interpolate: { value: 'monotone' } }),
  ], { data: dataset([[10, 120], [60, 30], [110, 100], [160, 40], [220, 90]].map(([x, y]) => ({ x, y }))) }),
  area: base([
    mk('area', { x: { field: 'x' }, y: { field: 'y' }, y2: { value: 140 }, fill: { value: '#4c78a8' } }),
  ], { data: dataset([[10, 120], [60, 50], [110, 100], [160, 60], [220, 90]].map(([x, y]) => ({ x, y }))) }),
  'area (curved, stroked)': base([
    mk('area', { x: { field: 'x' }, y: { field: 'y' }, y2: { value: 140 }, fill: { value: '#4c78a8' }, stroke: { value: '#000' }, strokeWidth: { value: 3 }, interpolate: { value: 'monotone' } }),
  ], { data: dataset([[10, 120], [60, 50], [110, 100], [160, 60], [220, 90]].map(([x, y]) => ({ x, y }))) }),
  trail: base([
    mk('trail', { x: { field: 'x' }, y: { field: 'y' }, size: { field: 's' }, fill: { value: '#4c78a8' } }),
  ], { data: dataset([[10, 120, 4], [60, 40, 14], [110, 100, 20], [160, 40, 8], [220, 90, 16]].map(([x, y, s]) => ({ x, y, s }))) }),
  'arcs (pie)': base([
    mk('arc', { x: { value: 120 }, y: { value: 80 }, outerRadius: { value: 70 }, startAngle: { field: 'a0' }, endAngle: { field: 'a1' }, fill: { value: '#4c78a8' }, stroke: { value: '#fff' }, strokeWidth: { value: 1 } }),
  ], { data: dataset([[0, 1.5], [1.5, 2.2], [2.2, 4.4], [4.4, 6.283185307179586]].map(([a0, a1]) => ({ a0, a1 }))) }),
  'arcs (donut, padded, rounded)': base([
    mk('arc', { x: { value: 120 }, y: { value: 80 }, outerRadius: { value: 70 }, innerRadius: { value: 35 }, padAngle: { value: 0.06 }, cornerRadius: { value: 4 }, startAngle: { field: 'a0' }, endAngle: { field: 'a1' }, fill: { value: '#4c78a8' } }),
  ], { data: dataset([[0, 2.1], [2.1, 3.3], [3.3, 6.283185307179586]].map(([a0, a1]) => ({ a0, a1 }))) }),
  paths: base([
    mk('path', { x: { field: 'x' }, y: { field: 'y' }, path: { value: 'M0,0L40,10L25,45L5,35Z M12,12L22,14L18,24Z' }, fill: { value: '#4c78a8' }, stroke: { value: '#000' }, strokeWidth: { value: 2 } }),
  ], { data: dataset(rowsOf(3, (i) => ({ x: 15 + i * 75, y: 40 }))) }),
  'shape marks': base([
    mk('shape', { path: { field: 'p' }, fill: { value: '#e45756' } }),
  ], { data: dataset([{ p: 'M10,10C60,10 60,60 10,60Z' }, { p: 'M120,20Q170,20 170,70L120,70Z' }, { p: 'M190,100A25,25 0,1,1 190,101Z' }]) }),
  'scaled paths': base([
    mk('path', { x: { field: 'x' }, y: { value: 30 }, scaleX: { value: 2 }, scaleY: { value: 1.5 }, path: { value: 'M0,0L20,0L20,30L0,30Z' }, fill: { value: '#4c78a8' } }),
  ], { data: dataset(rowsOf(2, (i) => ({ x: 20 + i * 100 }))) }),
}

interface Case { name: string; scene: SceneRoot }

const scenes: Case[] = Object.entries(SPECS).map(([name, spec]) => ({ name, scene: evaluateChart(compileChart(spec as never)) }))

const markGroups = (scene: SceneRoot): SceneGroup[] => scene.items.filter((g) => g.role === 'mark')

/** Painted records of one item, rendered alone (lines/areas/trails: the whole group is one shape). */
function recordsOf(scene: SceneRoot, group: SceneGroup, items: SceneItem[]): PaintRecord[] {
  const solo = { ...scene, items: [{ ...group, items }] } as SceneRoot
  const { ctx, records } = makeRecorder()
  renderSceneToCanvas(solo, ctx, { batchSymbols: false })
  return records.filter((r) => r.op !== 'text')
}

const perItem = new Set(['symbol', 'circle', 'rect', 'rule', 'arc', 'path', 'shape', 'geoshape', 'image'])

describe('hit index finds what is painted, and only that (audit C47)', () => {
  for (const { name, scene } of scenes) {
    it(`${name}: inside the painted geometry hits the item; outside everything hits nothing`, () => {
      const index = buildHitIndex(scene)
      const groups = markGroups(scene)
      const parts: Array<{ owner: SceneItem[]; records: PaintRecord[] }> = []
      for (const g of groups) {
        const items = (g.items ?? []) as SceneItem[]
        if (perItem.has(String(g.marktype))) for (const it of items) parts.push({ owner: [it], records: recordsOf(scene, g, [it]) })
        else parts.push({ owner: items, records: recordsOf(scene, g, items) })
      }
      expect(parts.some((p) => p.records.length > 0), 'something is painted').toBe(true)
      let inside = 0, outside = 0
      const bad: string[] = []
      for (let y = 0.5; y < H + 14; y += 2.5) {
        for (let x = 0.5; x < W + 14; x += 2.5) {
          const classes = parts.map((p) => classify(p.records, x, y))
          const hit = index.query(x, y)
          if (classes.includes('in')) {
            inside++
            const owners = parts.filter((_, i) => classes[i] === 'in').flatMap((p) => p.owner)
            const near = parts.filter((_, i) => classes[i] !== 'out').flatMap((p) => p.owner)
            if (!hit) bad.push(`(${x},${y}) is painted but nothing was found`)
            else if (!near.includes(hit.item)) bad.push(`(${x},${y}) is painted by ${owners.length} item(s) but found a different item`)
          } else if (classes.every((c) => c === 'out')) {
            outside++
            if (hit) bad.push(`(${x},${y}) is outside everything painted but found a ${hit.marktype} item`)
          }
          if (bad.length >= 6) break
        }
        if (bad.length >= 6) break
      }
      expect(inside, 'samples inside painted geometry').toBeGreaterThan(20)
      expect(outside, 'samples outside painted geometry').toBeGreaterThan(200)
      expect(bad.join('\n')).toBe('')
    })
  }

  it('hollow (transparent-fill) symbols are found from their centre, like vega', () => {
    const scene = evaluateChart(compileChart(base([
      mk('symbol', { x: { value: 100 }, y: { value: 80 }, size: { value: 900 }, fill: { value: 'transparent' }, stroke: { value: '#000' }, strokeWidth: { value: 2 } }),
    ], { data: dataset([{ k: 1 }]) }) as never))
    expect(buildHitIndex(scene).query(7 + 100, 7 + 80)).not.toBeNull()
    expect(buildHitIndex(scene).query(7 + 100 + 30, 7 + 80)).toBeNull()
  })

  it('an unpainted item (no fill, no stroke) is not pickable', () => {
    const scene = { width: 100, height: 100, items: [{ marktype: 'arc', items: [{ x: 50, y: 50, outerRadius: 30, startAngle: 0, endAngle: 6, datum: { a: 1 } }] }] } as unknown as SceneRoot
    expect(buildHitIndex(scene).query(50, 50)).toBeNull()
  })

  it('a pie slice is not found from the empty corner of its bounding box; its apex and body are', () => {
    const scene = evaluateChart(compileChart(SPECS['arcs (pie)'] as never))
    const index = buildHitIndex(scene)
    // slice 0: angle 0..1.5 rad from 12 o'clock, clockwise: covers the upper-right; its bbox corner top-left of the apex is empty
    const cx = 7 + 120, cy = 7 + 80
    expect(index.query(cx + 20, cy - 30)?.item.startAngle).toBe(0)
    expect(index.query(cx - 55, cy - 55)).toBeNull() // inside the pie's overall bbox, outside the circle
  })
})

describe('text hits follow the layout text box, rotated', () => {
  const textScene = (update: Record<string, unknown>): SceneRoot => evaluateChart(compileChart(base([
    mk('text', { x: { value: 120 }, y: { value: 80 }, text: { value: 'Hello world' }, fontSize: { value: 16 }, fill: { value: '#000' }, ...update }),
  ], { data: dataset([{ k: 1 }]) }) as never))

  for (const angle of [0, 30, 90, -45, 180]) {
    for (const align of ['left', 'center', 'right'] as const) {
      it(`angle ${angle}, align ${align}`, () => {
        const scene = textScene({ angle: { value: angle }, align: { value: align } })
        const item = (markGroups(scene)[0]!.items as SceneItem[])[0]!
        const index = buildHitIndex(scene)
        const w = textWidth(item, 'Hello world')
        const fs = fontSize(item)
        const a = (angle * Math.PI) / 180
        const c = Math.cos(a), s = Math.sin(a)
        // a point in the text's own frame -> viewport
        const at = (lx: number, ly: number): [number, number] => [7 + 120 + lx * c - ly * s, 7 + 80 + lx * s + ly * c]
        const left = align === 'left' ? 0 : align === 'right' ? -w : -w / 2
        const midY = baselineOffset(item) - 0.3 * fs
        // inside: the middle of the box, and near both ends along the baseline
        for (const lx of [left + 2, left + w / 2, left + w - 2]) {
          const [x, y] = at(lx, midY)
          expect(index.query(x, y)?.item, `inside at local x=${lx}`).toBe(item)
        }
        // outside: well past either end, and well above/below the box
        for (const [lx, ly] of [[left - 12, midY], [left + w + 12, midY], [left + w / 2, midY - fs * 2], [left + w / 2, midY + fs * 2]] as const) {
          const [x, y] = at(lx, ly)
          expect(index.query(x, y), `outside at local (${lx}, ${ly})`).toBeNull()
        }
      })
    }
  }

  it('multi-line text extends over all its lines', () => {
    const scene = textScene({ text: { value: ['first', 'second', 'third'] }, align: { value: 'left' } })
    const item = (markGroups(scene)[0]!.items as SceneItem[])[0]!
    expect(textLines(item)).toHaveLength(3)
    const index = buildHitIndex(scene)
    const y3 = 7 + 80 + 2 * lineHeight(item) - 4
    expect(index.query(7 + 120 + 4, y3)?.item).toBe(item)
    expect(index.query(7 + 120 + 4, 7 + 80 + 3 * lineHeight(item) + 12)).toBeNull()
  })

  it('rotated axis labels (guide leaves) are found along their rotation', () => {
    const scene = evaluateChart(compileChart({
      width: 200, height: 100, padding: 30, autosize: 'none',
      scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: 'width' }],
      axes: [{ scale: 'x', orient: 'bottom', labelAngle: 90, labelAlign: 'right', labelBaseline: 'middle', labelFontSize: 14 }],
    } as never))
    const axis = scene.items.find((g) => g.role === 'axis')!
    const labels = collectTexts(axis)
    const label = labels.find((t) => String(t.text) === '50')!
    const index = buildHitIndex(scene)
    const w = textWidth(label, '50')
    // rotated 90deg and right-aligned: the text runs up from its anchor
    const [ax, ay] = [30 + (axis.x ?? 0) + (label.x ?? 0), 30 + (axis.y ?? 0) + (label.y ?? 0)]
    expect(index.query(ax, ay - w / 2)?.item).toBe(label)
    expect(index.query(ax, ay + 24)).toBeNull() // the text runs up from its anchor, not down
  })
})

function collectTexts(g: SceneGroup): SceneItem[] {
  const out: SceneItem[] = []
  for (const it of g.items ?? []) {
    if ((it as SceneGroup).items) out.push(...collectTexts(it as SceneGroup))
    else if (it.text != null) out.push(it as SceneItem)
  }
  return out
}

// ---------------------------------------------------------------------------
// C41: the grid cannot be made to allocate without bound
// ---------------------------------------------------------------------------

describe('hit grid memory (audit C41)', () => {
  it('an enormous item, many small ones, and far-away items stay cheap and correct (in-process)', () => {
    const small = Array.from({ length: 401 }, (_, i) => ({ x: (i % 20) * 10, y: Math.floor(i / 20) * 10, width: 8, height: 8, fill: '#000', datum: { i } }))
    const scene = {
      width: 800, height: 600,
      // vega paints rect items in data order (the later datum on top), so the backdrop comes first
      items: [{ marktype: 'rect', items: [{ x: -1e6, y: -1e6, width: 2e6, height: 2e6, fill: '#ccc', datum: { i: 'huge' } }, ...small, { x: 1e12, y: 1e12, width: 5, height: 5, fill: '#f00', datum: { i: 'far' } }] }],
    } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    expect(index.queryMark(4, 4)?.item.datum).toEqual({ i: 0 }) // a small rect paints above the backdrop
    expect(index.queryMark(5000, 5000)?.item.datum).toEqual({ i: 'huge' })
    expect(index.queryMark(1e12 + 2, 1e12 + 2)).not.toBeNull()
    expect(index.queryMark(Number.NaN, 3)).toBeNull()
  })

  it('does not exhaust the heap: a 2e6 x 2e6 rect plus 401 small rects (child process with a 256 MB cap)', () => {
    // The old index allocated one list entry per covered cell: ~10^9 cells for
    // this rect, i.e. "FATAL ERROR: Reached heap limit". Run it in a child with a
    // memory cap so a regression cannot take the test runner down with it.
    const dir = mkdtempSync(join(tmpdir(), 'aster-hit-'))
    let res: ReturnType<typeof spawnSync>
    try {
      const bundle = join(dir, 'hit.mjs')
      buildSync({ entryPoints: [new URL('./hit.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent' })
      const script = `
        import { buildHitIndex } from ${JSON.stringify(bundle)};
        const small = Array.from({ length: 401 }, (_, i) => ({ x: (i % 20) * 10, y: Math.floor(i / 20) * 10, width: 8, height: 8, fill: '#000', datum: { i } }));
        const scene = { width: 800, height: 600, items: [{ marktype: 'rect', items: [{ x: -1e6, y: -1e6, width: 2e6, height: 2e6, fill: '#ccc', datum: { i: 'huge' } }, ...small] }] };
        const index = buildHitIndex(scene);
        const a = index.queryMark(4, 4)?.item.datum.i;
        const b = index.queryMark(700, 500)?.item.datum.i;
        console.log(JSON.stringify([a, b]));
      `
      res = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(String(res.stderr), 'child stderr').not.toMatch(/heap limit|out of memory/i)
    expect(res.status, `child exit (${res.signal ?? ''}) ${String(res.stderr).slice(0, 300)}`).toBe(0)
    expect(JSON.parse(String(res.stdout).trim().split('\n').pop()!)).toEqual([0, 'huge'])
  }, 90_000)
})
