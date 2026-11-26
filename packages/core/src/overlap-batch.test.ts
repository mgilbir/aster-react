// @vitest-environment node
/**
 * Symbols batched into one path because they cannot overlap (overlap-batch.ts, the renderers' translucent / blended /
 * filled-and-stroked symbols). The claim is: two symbols of one batch share no pixel, so one path draws what two elements draw.
 * Three checks, none of them the batcher's own arithmetic:
 *  - `symbolInkBox` holds the ink: every pixel a software canvas (raster.ts, the coverage a browser makes) inks for a symbol, for
 *    every shape, size, stroke width, cap, join, miter limit and angle, lies in the box;
 *  - the batcher's answer against a brute-force pairwise test of those boxes (a grid is not allowed to lose a neighbour);
 *  - the batches it makes on generated sequences of symbols (clusters, sparse fields, mixed sizes): no pixel is inked by two
 *    members of one batch, and a sequence that overlaps everywhere is not batched at all.
 */
import { describe, expect, it } from 'vitest'
import { AlphaCanvas } from './raster.js'
import { renderSceneToCanvas } from './canvas.js'
import { symbolInkBox } from './bounds.js'
import { batchablePaint } from './render.js'
import { DisjointBatch, disjointEnd } from './overlap-batch.js'
import { mulberry32, pick } from './scene-fuzz.testlib.js'
import type { SceneItem, SceneRoot } from './types.js'

const SPILL = 0.5
const W = 240
const H = 240

function alphaOf(it: SceneItem): Uint8Array {
  const scene = { width: W, height: H, padding: { top: 0, left: 0, right: 0, bottom: 0 }, items: [{ marktype: 'symbol', role: 'mark', items: [it] }] } as unknown as SceneRoot
  const c = new AlphaCanvas(W, H)
  renderSceneToCanvas(scene, c)
  return c.alpha
}

const SHAPES = ['circle', 'square', 'diamond', 'cross', 'triangle-up', 'triangle-down', 'triangle-left', 'triangle-right', 'stroke', 'M-1,-1L1,-1L0,1Z']

function randomItem(r: () => number, at: () => [number, number]): SceneItem {
  const [x, y] = at()
  const it: Record<string, unknown> = {
    x, y, size: pick(r, [1, 9, 30, 64, 200, 600, 1500]), shape: pick(r, SHAPES),
    fill: pick(r, ['steelblue', undefined, 'rgba(0,0,0,0.5)']), stroke: pick(r, [undefined, 'white', 'black']),
  }
  if (it.stroke !== undefined) {
    it.strokeWidth = pick(r, [0.5, 1, 2, 5, 11])
    if (r() < 0.4) it.strokeCap = pick(r, ['round', 'square', 'butt'])
    if (r() < 0.5) it.strokeJoin = pick(r, ['miter', 'round', 'bevel'])
    if (r() < 0.3) it.strokeMiterLimit = pick(r, [1, 2, 4, 10, 30])
    if (r() < 0.2) it.strokeDash = [3, 2]
  }
  if (r() < 0.3) it.angle = pick(r, [0, 15, 45, 90, 200])
  it.fillOpacity = pick(r, [0.4, 0.7])
  return it as unknown as SceneItem
}

describe('symbolInkBox holds the ink', () => {
  it('every inked pixel of a symbol lies in its box, over every shape, size, stroke and angle', () => {
    const r = mulberry32(37)
    let inked = 0
    for (let i = 0; i < 400; i++) {
      const it = randomItem(r, () => [60 + r() * 120, 60 + r() * 120])
      const box = [0, 0, 0, 0]
      expect(symbolInkBox(it, box), JSON.stringify(it)).toBe(true)
      const a = alphaOf(it)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (a[y * W + x] === 0) continue
          inked++
          // (the pixel square [x, x+1) x [y, y+1) meets the box grown by half a pixel: the most an antialiased edge, or a
          // hairline, spills; the batcher's pad of a whole pixel on every side leaves two apart boxes more than that between them)
          const inside = x + 1 > box[0]! - SPILL && x < box[2]! + SPILL && y + 1 > box[1]! - SPILL && y < box[3]! + SPILL
          if (!inside) throw new Error(`pixel ${x},${y} is inked outside the box ${box.join(',')} of ${JSON.stringify(it)}`)
        }
      }
    }
    expect(inked).toBeGreaterThan(10000)
  })

  it('a symbol that cannot be bounded is not', () => {
    const out = [0, 0, 0, 0]
    for (const bad of [{ x: 1, y: 1, size: NaN }, { x: 1, y: 1, size: Infinity }, { x: 1, y: 1, stroke: 'red', strokeWidth: NaN }]) {
      expect(symbolInkBox({ ...bad } as unknown as SceneItem, out), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('the batcher', () => {
  const fields: Array<[string, (r: () => number) => [number, number]]> = [
    ['sparse', (r) => [r() * W, r() * H]],
    ['clustered', (r) => { const c = Math.floor(r() * 4); return [30 + c * 50 + r() * 30, 30 + c * 40 + r() * 30] }],
    ['one spot', (r) => [100 + r() * 6, 100 + r() * 6]],
  ]

  it('agrees with a brute-force pairwise test of the boxes, at every position', () => {
    const r = mulberry32(5)
    for (let round = 0; round < 60; round++) {
      const [, at] = fields[round % fields.length]!
      const batch = new DisjointBatch()
      const boxes: number[][] = []
      for (let n = 0; n < 120; n++) {
        const it = randomItem(r, () => at(r))
        const b = [0, 0, 0, 0]
        if (!symbolInkBox(it, b)) continue
        const padded = [b[0]! - 1, b[1]! - 1, b[2]! + 1, b[3]! + 1]
        const wide = padded[2]! - padded[0]! >= 256 || padded[3]! - padded[1]! >= 256
        const free = boxes.every((o) => !(padded[0]! < o[2]! && o[0]! < padded[2]! && padded[1]! < o[3]! && o[1]! < padded[3]!))
        const took = batch.add(it)
        if (!wide) expect(took, `${round}.${n}`).toBe(free)
        if (took) boxes.push(padded)
      }
    }
  })

  it('no two members of a batch ink the same pixel; a field that overlaps everywhere is not batched', () => {
    const r = mulberry32(413)
    let batches = 0
    let members = 0
    for (let round = 0; round < 90; round++) {
      const [name, at] = fields[round % fields.length]!
      const items = Array.from({ length: 60 }, () => randomItem(r, () => at(r)))
      const alphas = new Map<SceneItem, Uint8Array>()
      const batch = new DisjointBatch()
      let from = 0
      while (from < items.length) {
        const to = Math.max(disjointEnd(batch, items, from, 256, () => true), from + 1)
        if (to - from >= 2) {
          batches++
          members += to - from
          const owner = new Int32Array(W * H).fill(-1)
          for (let k = from; k < to; k++) {
            const a = alphaOf(items[k]!)
            alphas.set(items[k]!, a)
            for (let p = 0; p < a.length; p++) {
              if (a[p] === 0) continue
              if (owner[p] !== -1) throw new Error(`${name}: items ${owner[p]} and ${k} of one batch both ink pixel ${p % W},${Math.floor(p / W)}: ${JSON.stringify([items[owner[p]!], items[k]])}`)
              owner[p] = k
            }
          }
        }
        from = to
      }
    }
    // (the property saw real batches: the sparse and clustered fields make them)
    expect(batches).toBeGreaterThan(40)
    expect(members).toBeGreaterThan(150)
  })

  it('a pile of symbols on one spot is not batched', () => {
    const r = mulberry32(8)
    const items = Array.from({ length: 80 }, () => ({ x: 100 + r() * 5, y: 100 + r() * 5, size: 200, shape: 'circle', fill: 'red', fillOpacity: 0.5 }) as unknown as SceneItem)
    const batch = new DisjointBatch()
    for (let from = 0; from < items.length; from++) expect(disjointEnd(batch, items, from, 256, () => true)).toBeLessThanOrEqual(from + 1)
  })

  it('canvas: a run painted in batches puts the pixels of one fill and stroke per symbol, whatever it overlaps', () => {
    const r = mulberry32(37)
    let batched = 0
    for (let round = 0; round < 60; round++) {
      const [name, at] = fields[round % fields.length]!
      // (one paint across the run)
      const paint = { fill: pick(r, ['steelblue', 'rgba(200,0,0,0.5)', undefined]), stroke: pick(r, ['white', 'black', undefined]), strokeWidth: pick(r, [1, 2, 3]), fillOpacity: pick(r, [0.4, 0.7, 1]), opacity: pick(r, [0.6, 1]) }
      if (paint.fill === undefined && paint.stroke === undefined) paint.fill = 'steelblue'
      // (an opaque run of a fill or a stroke is one path as it always was, and where its symbols overlap, a pixel at the edge of two
      // is covered once, not twice: that is the old batching's, not this one's)
      if (batchablePaint(paint as unknown as SceneItem)) continue
      // (a canvas run is symbols of one size and shape, as well as one paint)
      const look = { size: pick(r, [9, 30, 64, 120]), shape: pick(r, ['circle', 'square', 'diamond', 'cross']) }
      const items = Array.from({ length: 300 }, () => { const [x, y] = at(r); return { x, y, ...look, ...paint } as unknown as SceneItem })
      const scene = { width: W, height: H, padding: { top: 0, left: 0, right: 0, bottom: 0 }, items: [{ marktype: 'symbol', role: 'mark', items }] } as unknown as SceneRoot
      const on = new AlphaCanvas(W, H)
      const off = new AlphaCanvas(W, H)
      let fills = 0
      const count = (c: AlphaCanvas): AlphaCanvas => { const f = c.fill.bind(c); c.fill = (...a: Parameters<AlphaCanvas['fill']>) => { fills++; return f(...a) }; return c }
      renderSceneToCanvas(scene, count(on), { batchSymbols: true })
      const batchedFills = fills
      fills = 0
      renderSceneToCanvas(scene, count(off), { batchSymbols: false })
      expect(Array.from(on.alpha), `${name} round ${round}: ${JSON.stringify(paint)}`).toEqual(Array.from(off.alpha))
      if (paint.fill !== undefined && batchedFills < fills / 2) batched++
    }
    // (the batching did happen where the symbols are apart: the property is not vacuous)
    expect(batched).toBeGreaterThan(5)
  })
})
