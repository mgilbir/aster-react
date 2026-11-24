/**
 * Test-only (excluded from the published build): a refactor baseline -- the `legacy-*.testlib.ts` copies of the renderers as they
 * were on stack/3-expr, amended since to follow fixes (their headers say which) -- against the current renderers, consumer by
 * consumer, over one scene:
 *  - the SVG string (`renderSceneToSvg`), byte for byte;
 *  - the DOM descriptor tree (`sceneToDomDesc`, per item and dense-batched);
 *  - the canvas: every call and every property write on the context, numbers compared with `Object.is` (so -0 and NaN count),
 *    batched and unbatched, at dpr 1 and 2.
 * Such a baseline can only say "unchanged": a defect both sides share passes it. The consumers of mark geometry that vega has --
 * bounds, the pick, `intersect()`, and the path reading behind them -- are compared with real vega instead
 * (packages/conformance/src/geometry-vs-vega.test.ts, `pnpm conformance:geometry`), as is the label transform's painter.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { renderSceneToSvg } from './render.js'
import { renderSceneToSvg as legacySvg } from './legacy-render.testlib.js'
import { sceneToDomDesc, type DomRenderOptions } from './dom.js'
import { sceneToDomDesc as legacyDomDesc } from './legacy-dom.testlib.js'
import { renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene, type CanvasLike, type RenderCanvasOptions } from './canvas.js'
import {
  renderSceneToCanvas as legacyCanvas,
  renderSceneToCanvasAppend as legacyCanvasAppend,
  snapshotCanvasScene as legacySnapshot,
} from './legacy-canvas.testlib.js'
import './legacy-guide-caption.testlib.js'
import './guide-caption.js'

type Rnd = () => number

/** A number as text that tells -0, NaN and the infinities apart. */
const numText = (v: number): string => (Object.is(v, -0) ? '-0' : String(v))

function argText(v: unknown, ids: Map<object, number>): string {
  if (typeof v === 'number') return numText(v)
  if (v !== null && typeof v === 'object') {
    let id = ids.get(v)
    if (id === undefined) ids.set(v, (id = ids.size))
    return `#${id}`
  }
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

/** A 2D context that logs every call (with its exact arguments, arity included) and every property write. */
export function loggingContext(): { ctx: CanvasLike; log: string[] } {
  const log: string[] = []
  const ids = new Map<object, number>()
  const state: Record<string, unknown> = {
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineDashOffset: 0, imageSmoothingEnabled: true, globalCompositeOperation: 'source-over',
  }
  const gradient = (kind: string) => (...args: unknown[]): unknown => {
    const g = { addColorStop: (o: number, c: string) => { log.push(`stop(${argText(g, ids)},${numText(o)},${c})`) } }
    log.push(`${kind}(${args.map((a) => argText(a, ids)).join(',')})=${argText(g, ids)}`)
    return g
  }
  const methods: Record<string, unknown> = { createLinearGradient: gradient('linear'), createRadialGradient: gradient('radial'), createPattern: gradient('pattern') }
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in methods) return methods[k]
      if (k in t) return t[k]
      if (k === 'then') return undefined
      return (...args: unknown[]): void => { log.push(`${k}(${args.map((a) => argText(a, ids)).join(',')})`) }
    },
    set(t, k: string, v) { t[k] = v; log.push(`${k}=${argText(v, ids)}`); return true },
  }) as unknown as CanvasLike
  return { ctx, log }
}

function canvasLog(render: (ctx: CanvasLike) => void): string[] {
  const { ctx, log } = loggingContext()
  render(ctx)
  return log
}

export interface Diff { consumer: string; detail: string }

function firstDiff(a: readonly string[], b: readonly string[]): string | null {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `#${i}: old ${a[i]} / new ${b[i]} (lengths ${a.length} / ${b.length})`
  return null
}

/** Every mark container of the scene (a group whose items are mark items), with the offset of its frame. */
export function marksOf(scene: SceneRoot): Array<{ mark: SceneGroup; x: number; y: number }> {
  const out: Array<{ mark: SceneGroup; x: number; y: number }> = []
  const walk = (g: SceneGroup, x: number, y: number): void => {
    const gx = x + (g.x ?? 0)
    const gy = y + (g.y ?? 0)
    if (g.marktype && g.marktype !== 'group') out.push({ mark: g, x: gx, y: gy })
    for (const it of g.items ?? []) if (Array.isArray((it as SceneGroup).items)) walk(it as SceneGroup, gx, gy)
  }
  for (const g of scene.items ?? []) walk(g, 0, 0)
  return out
}

/** Probe points: a random spread over the view and around every item's position (on it, and just off it). */
export function probePoints(scene: SceneRoot, r: Rnd, random = 40, max = 160): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  const edge: Array<[number, number]> = []
  const W = scene.width || 200
  const H = scene.height || 200
  for (let i = 0; i < random; i++) pts.push([r() * (W + 20) - 10, r() * (H + 20) - 10])
  const padX = (scene.padding?.left ?? 0) + (scene.frameX ?? 0)
  const padY = (scene.padding?.top ?? 0) + (scene.frameY ?? 0)
  for (const { mark, x, y } of marksOf(scene)) {
    const items = mark.items ?? []
    const step = Math.max(1, Math.floor(items.length / 25))
    for (let i = 0; i < items.length; i += step) {
      const it = items[i] as SceneItem
      const ix = padX + x + (Number(it.x) || 0)
      const iy = padY + y + (Number(it.y) || 0)
      for (const [dx, dy] of [[0, 0], [1.5, 0.5], [-2.2, 1.1], [0.3, -3.1], [4, 4], [(Number(it.width) || 0) / 2, (Number(it.height) || 0) / 2]]) pts.push([ix + dx!, iy + dy!])
    }
  }
  // points exactly at the edge of a line/area/trail's pick band (half the stroke width, with and without a 2px slack, for the usual widths):
  // where 3-digit and full-precision geometry decide differently
  for (const { mark, x, y } of marksOf(scene)) {
    if (mark.marktype !== 'line' && mark.marktype !== 'area' && mark.marktype !== 'trail') continue
    const items = mark.items ?? []
    const step = Math.max(1, Math.floor(items.length / 12))
    for (let i = 0; i < items.length; i += step) {
      const it = items[i] as SceneItem
      const ix = padX + x + (Number(it.x) || 0)
      const iy = padY + y + (Number(it.y) || 0)
      for (const t of [0.5, 0.75, 1, 2, 2.5, 2.75, 3]) edge.push([ix, iy + t], [ix, iy - t], [ix + t, iy], [ix - t, iy])
    }
  }
  // a fixed budget per scene, spread over everything collected
  const out: Array<[number, number]> = []
  if (pts.length <= max) for (const p of pts) out.push(p)
  else for (let i = 0; i < max; i++) out.push(pts[Math.floor((i * pts.length) / max)]!)
  if (edge.length <= max) for (const p of edge) out.push(p)
  else for (let i = 0; i < max; i++) out.push(edge[Math.floor((i * edge.length) / max)]!)
  return out
}

/** Compares the SVG, DOM and canvas renderers, old vs new, on `scene`; returns the differences (empty: identical). */
export function diffScene(scene: SceneRoot, opts: { dom?: boolean; canvas?: boolean } = {}): Diff[] {
  const diffs: Diff[] = []
  const tryBoth = <T,>(consumer: string, oldFn: () => T, newFn: () => T, eq: (a: T, b: T) => string | null): void => {
    let a: T | Error
    let b: T | Error
    try { a = oldFn() } catch (e) { a = e as Error }
    try { b = newFn() } catch (e) { b = e as Error }
    if (a instanceof Error || b instanceof Error) {
      const am = a instanceof Error ? `throws ${a.message}` : 'returns'
      const bm = b instanceof Error ? `throws ${b.message}` : 'returns'
      if (am !== bm) diffs.push({ consumer, detail: `old ${am} / new ${bm}` })
      return
    }
    const d = eq(a, b)
    if (d !== null) diffs.push({ consumer, detail: d })
  }
  tryBoth('svg', () => legacySvg(scene), () => renderSceneToSvg(scene), (a, b) => (a === b ? null : firstDiff([a], [b])))
  if (opts.dom !== false) {
    for (const o of [{}, { denseMarks: true, denseChunkSize: 40 }] as DomRenderOptions[]) {
      tryBoth(`dom${o.denseMarks ? '-dense' : ''}`, () => JSON.stringify(legacyDomDesc(scene, o)), () => JSON.stringify(sceneToDomDesc(scene, o)), (a, b) => (a === b ? null : firstDiff([a], [b])))
    }
  }
  if (opts.canvas !== false) {
    for (const o of [{}, { batchSymbols: false }, { dpr: 2 }] as RenderCanvasOptions[]) {
      tryBoth(`canvas${JSON.stringify(o)}`, () => canvasLog((c) => legacyCanvas(scene, c, o)), () => canvasLog((c) => renderSceneToCanvas(scene, c, o)), firstDiff)
    }
  }
  return diffs
}

/** The canvas append path, old vs new: `prev` painted, then `next` appended on top (or refused). */
export function diffAppend(prev: SceneRoot, next: SceneRoot): Diff[] {
  const a = canvasLog((c) => { c.save(); const ok = legacyCanvasAppend(legacySnapshot(prev), next, c); c.restore(); if (!ok) c.restore() })
  const b = canvasLog((c) => { c.save(); const ok = renderSceneToCanvasAppend(snapshotCanvasScene(prev), next, c); c.restore(); if (!ok) c.restore() })
  const d = firstDiff(a, b)
  return d === null ? [] : [{ consumer: 'canvas-append', detail: d }]
}
