/**
 * The canonical form of a canvas drawing recorded with `recorder({ state: true })` (canvas-recorder.ts), for comparing what Aster's canvas
 * renderer paints with what vega-scenegraph's canvas code paints. Normalization is limited to differences that cannot change a pixel,
 * the same ones `normalize.ts` makes for SVG:
 *   - a paint that paints nothing is dropped: an empty path, a fully transparent colour, a zero alpha (N-paint-none);
 *   - a fill or stroke of several subpaths that paints what its subpaths painted one by one would paint is those subpaths, one record
 *     each (N-batch, by the rule of `batchPieces` in normalize.ts: no two subpaths' boxes meet; or an opaque undashed stroke; or an
 *     opaque nonzero fill of simple closed curves -- simple polygons, whole circles -- that all wind the same way);
 *   - records whose painted boxes do not meet may swap (the paint-order normal form); a record in a blend mode, or one whose box is
 *     unknown, is a barrier.
 * Every number is the recorder's (device space, rounded as it was asked to round).
 */
import { color } from 'd3-color'
import type { Painted } from './canvas-recorder.js'
import { anyBoxesMeet, paintNormalForm, simplePolygon, type Box } from './normalize.js'

interface Cmd { c: string; n: number[]; turn?: 1 | -1; lin?: number[] }

/**
 * A recorded path (`M1,2 L3,4 A5,6,7,8,2,6,9,+ O7,8,2,-@1,0,0,1 Q1,2 3,4 Z`, see `arcRecord` in canvas-recorder.ts) as commands: an
 * arc's numbers are its end, centre, radius and middle point, a circle's its centre and radius, each with its turn and linear part.
 */
function commands(path: string): Cmd[] | null {
  const out: Cmd[] = []
  for (const tok of path.split(' ')) {
    if (tok === '') continue
    const c = tok[0]!
    if (c === 'A' || c === 'O') {
      const [body, lin] = tok.slice(1).split('@')
      const parts = body!.split(',')
      const turn = parts.pop()
      if (turn !== '+' && turn !== '-') return null
      out.push({ c, n: parts.map(Number), turn: turn === '+' ? 1 : -1, ...(lin ? { lin: lin.split(',').map(Number) } : {}) })
      continue
    }
    if (!'MLQCTZ'.includes(c)) {
      // (the further points of a curve, as separate tokens)
      const last = out[out.length - 1]
      if (!last) return null
      for (const v of tok.split(',')) last.n.push(Number(v))
      continue
    }
    out.push({ c, n: tok.length > 1 ? tok.slice(1).split(',').map(Number) : [] })
  }
  return out
}

/** The box of a subpath, inflated by half the pen (times the miter limit for a mitred stroke) and a pixel of antialiasing. */
function boxOf(cmds: Cmd[], inflate: number): Box | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  const add = (x: number, y: number): void => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y) }
  for (const cmd of cmds) {
    if (cmd.c === 'A' || cmd.c === 'O') {
      // (the whole circle round the centre; under a linear part the radius grows by at most the larger sum of a row's magnitudes)
      const l = cmd.lin ?? [1, 0, 0, 1]
      const k = Math.max(Math.abs(l[0]!) + Math.abs(l[2]!), Math.abs(l[1]!) + Math.abs(l[3]!))
      const [cx, cy, r] = cmd.c === 'A' ? cmd.n.slice(2, 5) : cmd.n.slice(0, 3)
      add(cx! - r! * k, cy! - r! * k); add(cx! + r! * k, cy! + r! * k)
      if (cmd.c === 'A') add(cmd.n[0]!, cmd.n[1]!)
    } else for (let i = 0; i + 1 < cmd.n.length; i += 2) add(cmd.n[i]!, cmd.n[i + 1]!)
  }
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  return [x1 - inflate, y1 - inflate, x2 + inflate, y2 + inflate]
}

const field = (state: string, name: string): string | undefined => new RegExp(`(?:^| )${name}=(\\S+)`).exec(state)?.[1]

function inflationOf(p: Painted): number {
  if (p.op !== 'stroke') return 1
  const st = p.state ?? ''
  const width = Number(field(st, 'width') ?? 1)
  const miter = field(st, 'join') === 'miter' ? Math.max(1, Number(field(st, 'miter') ?? 10)) : 1
  const pen = (field(st, 'pen') ?? '1,0,0,1').split(',').map(Number)
  const scale = Math.max(Math.abs(pen[0]!) + Math.abs(pen[2]!), Math.abs(pen[1]!) + Math.abs(pen[3]!))
  const cap = field(st, 'cap') === 'square' ? Math.SQRT2 : 1
  return 1 + (width * scale * Math.max(miter, cap)) / 2
}

const opaqueColour = (style: string): boolean => { const c = color(style)?.rgb(); return c !== undefined && c.opacity === 1 }

/**
 * The way a subpath winds (1 or -1) when it is a simple closed curve -- a simple polygon (`M L.. Z`), or a whole circle (`M O`) -- and
 * 0 for anything else.
 */
function windingOf(sub: Cmd[]): number {
  if (sub.length === 2 && sub[0]!.c === 'M' && sub[1]!.c === 'O') {
    // (a circle under a linear part is an ellipse, turned the other way by a reflection)
    const l = sub[1]!.lin ?? [1, 0, 0, 1]
    const det = l[0]! * l[3]! - l[1]! * l[2]!
    return det === 0 ? 0 : sub[1]!.turn! * Math.sign(det)
  }
  if (sub[0]!.c !== 'M' || sub[sub.length - 1]!.c !== 'Z' || !sub.slice(1).every((x) => x.c === 'L' || x.c === 'Z')) return 0
  const xy = sub.flatMap((x) => x.n)
  if (!simplePolygon(xy)) return 0
  let area = 0
  for (let i = 0; i < xy.length; i += 2) {
    const j = (i + 2) % xy.length
    area += xy[i]! * xy[j + 1]! - xy[j]! * xy[i + 1]!
  }
  return area > 0 ? 1 : area < 0 ? -1 : 0
}

/** Whether every subpath is a simple closed curve and all wind the same way (a nonzero fill of them is the union of the shapes). */
function sameWayClosed(subs: Cmd[][]): boolean {
  const w = windingOf(subs[0]!)
  return w !== 0 && subs.every((sub) => windingOf(sub) === w)
}

/** The canonical records of a recorded drawing. */
export function canonicalPaints(painted: readonly Painted[]): string[] {
  const recs: Array<{ text: string; box: Box | null }> = []
  for (const p of painted) {
    const st = p.state ?? ''
    if (p.path === '' || field(st, 'alpha') === '0') continue
    const c = color(p.style)?.rgb()
    if (c !== undefined && c.opacity === 0) continue
    const tail = ` ${p.style} {${st}}`
    const barrier = (field(st, 'blend') ?? 'source-over') !== 'source-over'
    const cmds = p.op === 'text' || p.path.startsWith('text ') ? null : commands(p.path)
    if (cmds === null || barrier) { recs.push({ text: `${p.op} ${p.path}${tail}`, box: null }); continue }
    const subs: Cmd[][] = []
    for (const cmd of cmds) { if (cmd.c === 'M' || !subs.length) subs.push([]); subs[subs.length - 1]!.push(cmd) }
    const parts = p.path.split(/ (?=M)/)
    const boxes = subs.map((s) => boxOf(s, inflationOf(p)))
    const whole = boxOf(cmds, inflationOf(p))
    const split = subs.length > 1 && parts.length === subs.length && boxes.every((b) => b !== null) && (
      !anyBoxesMeet(boxes as Box[])
      || (field(st, 'alpha') === '1' && opaqueColour(p.style) && (
        p.op === 'stroke' ? field(st, 'dash') === undefined : sameWayClosed(subs))))
    if (split) parts.forEach((part, i) => recs.push({ text: `${p.op} ${part}${tail}`, box: boxes[i]! }))
    else recs.push({ text: `${p.op} ${p.path}${tail}`, box: whole })
  }
  return paintNormalForm(recs)
}
