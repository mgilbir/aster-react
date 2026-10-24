/**
 * Test-only scene generator shared by the DOM, canvas and hit-index oracles
 * (excluded from the published build): random specs over every mark the
 * renderers handle, and random row edits (insert/remove/append/edit/...).
 * Same idea as incremental-oracle.test.ts, widened to the renderers' marks.
 */
import type { RuntimeInput } from './types.js'

type Row = Record<string, unknown>
type Rnd = () => number

export function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const pick = <T,>(r: Rnd, a: readonly T[]): T => a[Math.floor(r() * a.length)]!
export const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))

// ---------------------------------------------------------------------------
// Spec + world generator
// ---------------------------------------------------------------------------

export const MARKS = ['symbol', 'symbol', 'rect', 'text', 'line', 'area', 'rule', 'circle', 'arc', 'trail', 'path'] as const
export type MarkKind = typeof MARKS[number]

export interface Gen { spec: Record<string, unknown>; label: string; dense: boolean; kind: MarkKind }

const FILLS = ['#4c78a8', '#f58518', 'rgba(10,20,30,0.5)', 'transparent']

export function markSpec(r: Rnd, kind: MarkKind, from: string): Record<string, unknown> {
  const upd: Record<string, unknown> = {
    x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v' },
  }
  const paint = (): void => {
    if (r() < 0.5) upd.fill = { scale: 'color', field: 'g' }
    else upd.fill = { value: pick(r, FILLS) }
    if (r() < 0.3) upd.fillOpacity = { value: 0.6 }
    if (r() < 0.3) { upd.stroke = { value: '#222' }; upd.strokeWidth = { value: 1.5 } }
    if (r() < 0.2) upd.strokeDash = { value: [3, 2] }
    if (r() < 0.2) upd.opacity = { value: 0.8 }
  }
  switch (kind) {
    case 'symbol':
      paint()
      upd.size = r() < 0.5 ? { value: 40 } : { signal: '20 + datum.v * 3' }
      if (r() < 0.3) upd.shape = { value: pick(r, ['square', 'diamond', 'cross', 'triangle-up']) }
      if (r() < 0.2) upd.angle = { signal: 'datum.v * 5' }
      break
    case 'circle':
      paint(); upd.size = { value: 60 }
      break
    case 'rect':
      paint()
      upd.width = { value: 6 }; upd.y2 = { scale: 'y', value: 0 }
      break
    case 'text':
      upd.text = { field: 'g' }
      upd.fill = { value: '#333' }
      upd.fontSize = { value: pick(r, [9, 11, 13]) }
      if (r() < 0.4) upd.angle = { signal: 'datum.v * 3' }
      if (r() < 0.4) upd.baseline = { value: pick(r, ['top', 'middle', 'bottom']) }
      if (r() < 0.3) upd.align = { value: pick(r, ['left', 'right']) }
      break
    case 'line':
      upd.stroke = { value: pick(r, ['#333', '#a33']) }
      if (r() < 0.3) upd.strokeDash = { value: [4, 3] }
      if (r() < 0.3) upd.interpolate = { value: 'monotone' }
      break
    case 'area':
      upd.y2 = { scale: 'y', value: 0 }
      paint()
      if (r() < 0.3) upd.interpolate = { value: 'monotone' }
      break
    case 'rule':
      upd.x2 = { scale: 'x', field: 'x' }; upd.y2 = { scale: 'y', value: 0 }
      upd.stroke = { scale: 'color', field: 'g' }
      if (r() < 0.3) upd.strokeDash = { value: [2, 2] }
      if (r() < 0.3) upd.strokeOpacity = { value: 0.5 }
      break
    case 'arc':
      upd.x = { value: 100 }; upd.y = { value: 80 }
      upd.startAngle = { signal: 'datum.x * 0.5' }; upd.endAngle = { signal: 'datum.x * 0.5 + 0.4' }
      upd.outerRadius = { signal: '30 + datum.v' }; upd.innerRadius = { value: r() < 0.5 ? 0 : 10 }
      paint()
      if (r() < 0.3) upd.padAngle = { value: 0.05 }
      break
    case 'trail':
      upd.size = { signal: '2 + datum.v / 4' }
      paint()
      if (!('fill' in upd)) upd.fill = { value: '#4c78a8' }
      break
    case 'path':
      upd.path = { signal: "'M0,0L' + datum.x + ',' + datum.v + 'L5,5Z'" }
      paint()
      break
  }
  return { type: kind === 'path' ? 'path' : kind, from: { data: from }, encode: { update: upd } }
}

export interface GenOptions {
  /** Scale domains computed from the data (a grown domain moves/re-colours existing marks and changes guides). */
  dataDomains?: boolean
}

export function genSpec(r: Rnd, forceDense: boolean, kinds: readonly MarkKind[] = MARKS, opts: GenOptions = {}): Gen {
  const kind: MarkKind = forceDense ? 'symbol' : pick(r, kinds)
  const marks: Array<Record<string, unknown>> = [markSpec(r, kind, 't')]
  const labels: string[] = [kind]
  if (!forceDense && r() < 0.4) {
    const k2 = pick(r, kinds)
    marks.push(markSpec(r, k2, 't'))
    labels.push(k2)
  }
  if (!forceDense && r() < 0.25) {
    // A second, independent dataset: removals in one must not disturb the other.
    marks.push(markSpec(r, pick(r, kinds.filter((k) => k === 'symbol' || k === 'text' || k === 'rect' || k === 'rule')), 'u'))
    labels.push('u-mark')
  }
  const spec: Record<string, unknown> = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 240, height: 160, padding: 5, autosize: 'none',
    data: [{ name: 't' }, { name: 'u' }],
    scales: [
      { name: 'x', type: 'linear', domain: opts.dataDomains ? { data: 't', field: 'x' } : forceDense ? [0, 1000] : [0, 12], range: 'width' },
      { name: 'y', type: 'linear', domain: opts.dataDomains ? { data: 't', field: 'v' } : [0, 24], range: 'height', zero: true },
      { name: 'color', type: 'ordinal', domain: opts.dataDomains ? { data: 't', field: 'g' } : ['A', 'B', 'C', 'D'], range: 'category' },
    ],
    axes: forceDense ? [] : [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
    legends: !forceDense && r() < 0.25 ? [{ fill: 'color' }] : [],
    marks,
  }
  if (!forceDense && r() < 0.3) spec.background = 'white'
  return { spec, label: labels.join('+') + (forceDense ? ' dense' : ''), dense: forceDense, kind }
}

export interface World { t: Row[]; u: Row[] }
export const GROUPS = ['A', 'B', 'C', 'D'] as const
export const rowOf = (r: Rnd, dense: boolean): Row => ({ x: dense ? int(r, 0, 1000) : int(r, 0, 12), v: int(r, 0, 24), g: pick(r, GROUPS) })

export type Op = 'edit' | 'insert' | 'remove' | 'append' | 'truncate' | 'shuffle' | 'replaceAll' | 'editU' | 'noop' | 'removeFirst' | 'removeMany'
export const OPS: Op[] = ['edit', 'edit', 'insert', 'remove', 'remove', 'removeFirst', 'removeMany', 'append', 'append', 'truncate', 'shuffle', 'replaceAll', 'editU', 'noop']

export function applyOp(r: Rnd, w: World, op: Op, dense: boolean): World {
  const t = w.t.slice()
  const u = w.u.slice()
  const at = (n: number): number => (n <= 0 ? 0 : Math.floor(r() * n))
  switch (op) {
    case 'edit': for (let k = 0; k < 1 + at(3) && t.length; k++) t[at(t.length)] = rowOf(r, dense); break
    case 'insert': t.splice(at(t.length + 1), 0, ...Array.from({ length: 1 + at(3) }, () => rowOf(r, dense))); break
    case 'remove': if (t.length > 1) t.splice(at(t.length), 1); break
    case 'removeFirst': if (t.length > 1) t.splice(0, 1); break
    case 'removeMany': for (let k = 0; k < 3 && t.length > 1; k++) t.splice(at(t.length), 1); break
    case 'append': for (let k = 0; k < 1 + at(3); k++) t.push(rowOf(r, dense)); break
    case 'truncate': t.length = Math.max(1, t.length - 1 - at(3)); break
    case 'shuffle': for (let i = t.length - 1; i > 0; i--) { const j = at(i + 1); const tmp = t[i]!; t[i] = t[j]!; t[j] = tmp } break
    case 'replaceAll': { const n = dense ? int(r, 520, 700) : int(r, 2, 9); t.length = 0; for (let i = 0; i < n; i++) t.push(rowOf(r, dense)); break }
    case 'editU': if (u.length) u[at(u.length)] = rowOf(r, dense); else u.push(rowOf(r, dense)); if (r() < 0.3) u.pop(); break
    case 'noop': break
  }
  return { t, u }
}

export const clone = <T,>(v: T): T => structuredClone(v)
export const inputOf = (w: World): RuntimeInput => ({ data: { t: clone(w.t), u: clone(w.u) } })

