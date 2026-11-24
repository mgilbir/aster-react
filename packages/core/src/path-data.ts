/**
 * The one reader of SVG path text, and the replays of what it reads.
 *
 * Path text reaches the engine two ways, and the reader serves both with one grammar (vega-scenegraph `path/parse.js`'s, the
 * observable one: what a number may look like, a one-digit arc flag, the error a malformed path throws):
 *  - text a spec writes: a path mark's `path`, a custom symbol `shape` (a legend's symbols too). Vega reads it with that grammar,
 *    so does `svgPathCommands`, which throws vega's `Invalid SVG path, ...` errors where vega's parser does. A canvas, the hit
 *    index, `intersect()` and the label transform's occupancy draw a path mark's text as far as it reads (`drawnPathCommands`):
 *    the commands before the first error, which is what a browser shows of the same text in vega's SVG, where the attribute is
 *    the text as written.
 *  - text the engine writes (an arc's, a rect's, a guide's, a geo shape's) and reads back to draw it on a canvas or to hit it
 *    (`parsePathData`): the same grammar, and the words JavaScript prints for a number that is not finite (`NaN`, `Infinity`,
 *    `-Infinity`) read as NaN where they stand. Vega draws those shapes into the canvas directly, which ignores a call with a
 *    number that is not finite; read as NaN, the call is ignored the same way, and the flattener and the hit index leave the
 *    point out of a box as the canvas leaves it out of the path (an infinite coordinate would make the box infinite).
 *
 * Two replays: `renderSvgPath` is vega-scenegraph `path/render.js` (what vega draws a spec's path text with: arcs as cubic
 * beziers, a smooth curve after a straight segment reflecting the last control point it kept, scale and offset applied to the
 * numbers before the arcs are computed); `tracePath` replays absolute segments (`parsePathData`) by the SVG rules, an arc as a
 * canvas arc (vega draws the engine's own shapes through the canvas directly) or, asked, as vega's beziers.
 *
 * It lives apart from canvas.ts so that hit testing does not pull the renderer into a bundle: an app that uses
 * `@aster-charts/core/hit` (tooltips, point selection) but never draws to a canvas must not contain `@aster-charts/core/canvas`.
 * `@aster-charts/core/canvas` re-exports `parsePathData`, `tracePath`, `PathSeg` and `PathSink`, so its public surface is unchanged.
 */

/** A command as written: its letter (upper case absolute, lower case relative) and its numbers. */
export type PathCommand = [string, ...number[]]

/** A command of `parsePathData`: absolute, a moveto's extra pairs as linetos. */
export type PathSeg =
  | { cmd: 'M' | 'm'; x: number; y: number }
  | { cmd: 'L' | 'l'; x: number; y: number }
  | { cmd: 'H' | 'h'; x: number }
  | { cmd: 'V' | 'v'; y: number }
  | { cmd: 'C' | 'c'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { cmd: 'S' | 's'; c2x: number; c2y: number; x: number; y: number }
  | { cmd: 'Q' | 'q'; cx: number; cy: number; x: number; y: number }
  | { cmd: 'T' | 't'; x: number; y: number }
  | { cmd: 'A' | 'a'; rx: number; ry: number; rot: number; large: number; sweep: number; x: number; y: number }
  | { cmd: 'Z' | 'z' }

// --- the grammar ------------------------------------------------------------------------------------------------------------

/** How many numbers each command takes. */
const ARITY: Readonly<Record<string, number>> = { m: 2, l: 2, h: 1, v: 1, z: 0, c: 6, s: 4, q: 4, t: 2, a: 7 }
const NUMBER = /^[+-]?(([0-9]*\.[0-9]+)|([0-9]+\.)|([0-9]+))([eE][+-]?[0-9]+)?/
/** What JavaScript prints for a number that is not finite (the engine's text may hold one; a spec's never reads as one). */
const JS_WORD = /^(NaN|[+-]?Infinity)/
const SEPARATOR = /^((\s+,?\s*)|(,\s*))/
const FLAG = /^[01]/

const isCommandLetter = (c: string): boolean => Object.hasOwn(ARITY, c.toLowerCase()) && c.length === 1

/** How a malformed path is read: refused with vega's error, or read as far as it goes. */
type OnError = 'throw' | 'stop'

/**
 * Read path text into its commands. Text before the first command letter is not read; a command's numbers are everything up to the
 * next command letter, read in groups of its arity (a group the text ends inside, or anything that is not a number, a separator or
 * an arc flag where one goes, is an error: "incorrect parameter type"; a command with no numbers that needs some: "incorrect
 * parameter count"). A moveto's extra groups are linetos, any other command's are the command again. With `onError: 'stop'` the
 * reading ends at the first error, with every command read before it. `jsNumbers` reads `NaN` and `±Infinity` as NaN.
 */
function readCommands(d: string, onError: OnError, jsNumbers: boolean, singles = false): PathCommand[] {
  const out: PathCommand[] = []
  const n = d.length
  let i = 0
  while (i < n && !isCommandLetter(d[i]!)) i = skipWord(d, i, jsNumbers)
  while (i < n) {
    const cmd = d[i]!
    let end = i + 1
    while (end < n && !isCommandLetter(d[end]!)) end = skipWord(d, end, jsNumbers)
    const type = cmd.toLowerCase()
    const arity = ARITY[type]!
    const read = readNumbers(type, arity, d.slice(i + 1, end).trim(), jsNumbers, singles)
    i = end
    const count = read.numbers.length
    if (read.failed || count < arity) {
      if (onError === 'throw') throw new Error(read.failed ? 'Invalid SVG path, incorrect parameter type' : 'Invalid SVG path, incorrect parameter count')
      // (as far as it reads: the groups before the error)
      pushGroups(out, cmd, type, arity, read.numbers, count - (count % (arity || 1)))
      break
    }
    pushGroups(out, cmd, type, arity, read.numbers, count)
  }
  return out
}

/** The next index to look at from `i`: past a JavaScript number word when those are read (its letters are not commands), else `i + 1`. */
function skipWord(d: string, i: number, jsNumbers: boolean): number {
  if (jsNumbers) {
    const m = JS_WORD.exec(d.slice(i, i + 9))
    if (m !== null) return i + m[0].length
  }
  return i + 1
}

/** The commands of `count` numbers of command `cmd`: the first group as written, the rest as linetos after a moveto, else repeats. */
function pushGroups(out: PathCommand[], cmd: string, type: string, arity: number, numbers: number[], count: number): void {
  if (arity === 0) { out.push([cmd]); return }
  if (count === 0) return
  out.push([cmd, ...numbers.slice(0, arity)])
  const again = type === 'm' ? (cmd === 'M' ? 'L' : 'l') : cmd
  for (let k = arity; k < count; k += arity) out.push([again, ...numbers.slice(k, k + arity)])
}

/** The numbers of one command's text, group by group; `failed` when something in it is not what goes there. */
function readNumbers(type: string, arity: number, text: string, jsNumbers: boolean, singles = false): { numbers: number[]; failed: boolean } {
  const numbers: number[] = []
  for (let at = 0; arity && at < text.length;) {
    for (let k = 0; k < arity; ++k) {
      const rest = text.slice(at)
      const m = (type === 'a' && (k === 3 || k === 4) ? FLAG : NUMBER).exec(rest) ?? (jsNumbers ? JS_WORD.exec(rest) : null)
      if (m === null) return { numbers, failed: true }
      at += m[0].length
      // (in the engine's text a number that is not finite is NaN: see the module's note)
      const v = +m[0]
      // (a browser reads a number into a float: one beyond single precision is no number there, as the word `NaN` is none)
      if (singles && !(Math.abs(v) < SINGLE_OVERFLOW)) return { numbers, failed: true }
      numbers.push(jsNumbers && !Number.isFinite(v) ? NaN : v)
      const sep = SEPARATOR.exec(text.slice(at))
      if (sep !== null) at += sep[0].length
    }
  }
  return { numbers, failed: false }
}

// --- what reads it, cached --------------------------------------------------------------------------------------------------

/** A bounded cache (cleared when full): many items share one path text (symbols, axes, legends). */
function cached<T>(limit: number, make: (d: string) => T): (d: string) => T {
  const cache = new Map<string, T>()
  // (the texts held, in characters: what a cache of a path's commands, segments and flattened outline costs grows with them, so
  // the cache is bounded by their size as well as their number -- a text larger than the whole budget is read every time)
  let chars = 0
  return (d) => {
    let v = cache.get(d)
    if (v === undefined) {
      v = make(d)
      if (d.length > PATH_CACHE_CHARS) return v
      if (cache.size >= limit || chars + d.length > PATH_CACHE_CHARS) { cache.clear(); chars = 0 }
      cache.set(d, v)
      chars += d.length
    }
    return v
  }
}

/** The characters of path text a parse cache holds at most (each cache; a path's segments take a few times its text). */
const PATH_CACHE_CHARS = 1 << 21

/**
 * A spec's path text as vega's parser reads it: its commands, or vega's error (not cached, thrown every time). Shared: never write
 * the commands.
 */
const readSpecPath = cached(4096, (d) => readCommands(d, 'throw', false))
export const svgPathCommands = (path: string): PathCommand[] => {
  // (vega reads the text with `path.match(...)`: a value that is no text -- a number, an object -- throws the TypeError the engine
  // gives that call)
  if (typeof path !== 'string') (path as { match(pattern: RegExp): unknown }).match(COMMAND_LETTERS)
  return readSpecPath(path)
}
const COMMAND_LETTERS = /[mlhvzcsqta]/gi

/** A spec's path text as far as it reads (see the module's note): what a canvas, the hit index and `intersect()` draw. Shared. */
export const drawnPathCommands: (d: string) => PathCommand[] = cached(4096, (d) => readCommands(d, 'stop', false))

/** Parse an SVG path `d` string (the engine's own text) into absolute segments. Shared: never write them. */
export const parsePathData: (d: string) => PathSeg[] = cached(4096, (d) => segmentsOf(readCommands(d, 'stop', true)))

/** The least magnitude a double that a browser keeps in a float is not finite at (2^128 - 2^103). */
const SINGLE_OVERFLOW = 3.4028235677973366e38

/**
 * Path text as a browser reads an SVG `d` (blink's path parser): the commands up to the first thing that is no number -- `NaN`, `Infinity`
 * or a number beyond single precision included -- are drawn, and the rest is not. (`parsePathData` reads what the engine writes: its
 * words for a number that is not finite are numbers there.)
 */
export const parseSvgPathData: (d: string) => PathSeg[] = cached(4096, (d) => segmentsOf(readCommands(d, 'stop', false, true)))

/** Commands as absolute segments: a relative command is offset by the current point (a close returns it to its subpath's start). */
function segmentsOf(commands: readonly PathCommand[]): PathSeg[] {
  const segs: PathSeg[] = []
  let x = 0, y = 0, startX = 0, startY = 0
  for (const c of commands) {
    const letter = c[0]
    const rel = letter !== letter.toUpperCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    const a = c as unknown as number[]
    switch (letter.toUpperCase()) {
      case 'M': x = a[1]! + ox; y = a[2]! + oy; startX = x; startY = y; segs.push({ cmd: 'M', x, y }); break
      case 'L': x = a[1]! + ox; y = a[2]! + oy; segs.push({ cmd: 'L', x, y }); break
      case 'H': x = a[1]! + ox; segs.push({ cmd: 'H', x }); break
      case 'V': y = a[1]! + oy; segs.push({ cmd: 'V', y }); break
      case 'C': segs.push({ cmd: 'C', c1x: a[1]! + ox, c1y: a[2]! + oy, c2x: a[3]! + ox, c2y: a[4]! + oy, x: (x = a[5]! + ox), y: (y = a[6]! + oy) }); break
      case 'S': segs.push({ cmd: 'S', c2x: a[1]! + ox, c2y: a[2]! + oy, x: (x = a[3]! + ox), y: (y = a[4]! + oy) }); break
      case 'Q': segs.push({ cmd: 'Q', cx: a[1]! + ox, cy: a[2]! + oy, x: (x = a[3]! + ox), y: (y = a[4]! + oy) }); break
      case 'T': x = a[1]! + ox; y = a[2]! + oy; segs.push({ cmd: 'T', x, y }); break
      case 'A': x = a[6]! + ox; y = a[7]! + oy; segs.push({ cmd: 'A', rx: a[1]!, ry: a[2]!, rot: a[3]!, large: a[4]!, sweep: a[5]!, x, y }); break
      case 'Z': x = startX; y = startY; segs.push({ cmd: 'Z' }); break
    }
  }
  return segs
}

// --- replays ----------------------------------------------------------------------------------------------------------------

/** The part of a 2D context that path tracing needs (so geometry consumers can flatten a path without a canvas). */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  closePath(): void
}

/** What `renderSvgPath` draws on: a path sink without arcs (they are drawn as beziers). */
export type BezierSink = Omit<PathSink, 'arc'>

const DEG_TO_RAD = Math.PI / 180

/**
 * vega-scenegraph path/arc.js (Inkscape svgtopdf): the SVG endpoint arc from (ox, oy) to (x, y) as cubic beziers of at most a
 * quarter turn each, handed to `to` (absolute). The floating-point steps are vega's, in its order: the beziers are its, bit for bit.
 */
function arcBeziersTo(to: (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) => void, ox: number, oy: number, rx: number, ry: number, rotateX: number, large: number, sweep: number, x: number, y: number): void {
  const th = rotateX * DEG_TO_RAD
  const sinTh = Math.sin(th)
  const cosTh = Math.cos(th)
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const px = cosTh * (ox - x) * 0.5 + sinTh * (oy - y) * 0.5
  const py = cosTh * (oy - y) * 0.5 - sinTh * (ox - x) * 0.5
  let pl = (px * px) / (rx * rx) + (py * py) / (ry * ry)
  if (pl > 1) {
    pl = Math.sqrt(pl)
    rx *= pl
    ry *= pl
  }
  const a00 = cosTh / rx
  const a01 = sinTh / rx
  const a10 = -sinTh / ry
  const a11 = cosTh / ry
  const x0 = a00 * ox + a01 * oy
  const y0 = a10 * ox + a11 * oy
  const x1 = a00 * x + a01 * y
  const y1 = a10 * x + a11 * y
  const d = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)
  let sfactorSq = 1 / d - 0.25
  if (sfactorSq < 0) sfactorSq = 0
  let sfactor = Math.sqrt(sfactorSq)
  // (a flag compares by value, as vega's `==`: a parsed flag is a number, a hand-built segment may hold another type)
  // eslint-disable-next-line eqeqeq
  if (sweep == large) sfactor = -sfactor
  const xc = 0.5 * (x0 + x1) - sfactor * (y1 - y0)
  const yc = 0.5 * (y0 + y1) + sfactor * (x1 - x0)
  const th0 = Math.atan2(y0 - yc, x0 - xc)
  const th1 = Math.atan2(y1 - yc, x1 - xc)
  let thArc = th1 - th0
  if (thArc < 0 && sweep === 1) thArc += 2 * Math.PI
  else if (thArc > 0 && sweep === 0) thArc -= 2 * Math.PI
  const segs = Math.ceil(Math.abs(thArc / (Math.PI / 2 + 0.001)))
  const b00 = cosTh * rx
  const b01 = -sinTh * ry
  const b10 = sinTh * rx
  const b11 = cosTh * ry
  for (let i = 0; i < segs; ++i) {
    const t0 = th0 + (i * thArc) / segs
    const t1 = th0 + ((i + 1) * thArc) / segs
    const thHalf = 0.5 * (t1 - t0)
    const sinThH2 = Math.sin(thHalf * 0.5)
    const t = ((8 / 3) * sinThH2 * sinThH2) / Math.sin(thHalf)
    const cos0 = Math.cos(t0), sin0 = Math.sin(t0), cos1 = Math.cos(t1), sin1 = Math.sin(t1)
    const bx1 = xc + cos0 - t * sin0
    const by1 = yc + sin0 + t * cos0
    const bx3 = xc + cos1
    const by3 = yc + sin1
    const bx2 = bx3 + t * sin1
    const by2 = by3 - t * cos1
    to(b00 * bx1 + b01 * by1, b10 * bx1 + b11 * by1, b00 * bx2 + b01 * by2, b10 * bx2 + b11 * by2, b00 * bx3 + b01 * by3, b10 * bx3 + b11 * by3)
  }
}

/**
 * The beziers vega draws an SVG endpoint arc with (see `arcBeziersTo`): six numbers per bezier (c1x, c1y, c2x, c2y, x, y), absolute.
 */
export function arcBeziers(ox: number, oy: number, rx: number, ry: number, rotateX: number, large: number, sweep: number, x: number, y: number): number[] {
  const out: number[] = []
  arcBeziersTo((a, b, c, d, e, f) => { out.push(a, b, c, d, e, f) }, ox, oy, rx, ry, rotateX, large, sweep, x, y)
  return out
}

/**
 * Draw commands as vega-scenegraph `path/render.js` draws them, scaled by (sX, sY) and moved by (l, t). Forced by what vega draws,
 * to the bit: every number of a command is scaled first (an arc's radii and end, not its rotation or flags); a relative command
 * is offset by the current point and an absolute one is taken as it is; the offset is added last; an arc is its beziers
 * computed from the moved points. A smooth curve reflects the control point the replay last kept, whatever the command before
 * it was (`S`, `s` and `T`); only `t` looks at the command before it, which in a scaled replay is always read as a `t`, and
 * which a path cannot start without (vega reads the letter of a command that is not there).
 */
export function renderSvgPath(sink: BezierSink, path: readonly PathCommand[], l = 0, t = 0, sX = 1, sY = sX): void {
  const scaledReplay = sX !== 1 || sY !== 1
  let previous: string | null = null
  let x = 0, y = 0
  // the control point kept for a smooth curve; the one a `t` made; the start of the subpath
  let cx = 0, cy = 0
  // (vega's starts unset: a `t` read as following a `t` before any did reflects nothing, NaN)
  let tcx = NaN, tcy = NaN
  let ax = 0, ay = 0
  let ex: number, ey: number
  const curve = (c1x: number, c1y: number, c2x: number, c2y: number, x3: number, y3: number): void => { sink.bezierCurveTo(c1x, c1y, c2x, c2y, x3, y3) }
  for (const cmd of path) {
    const c = (scaledReplay ? scaled(cmd, sX, sY) : cmd) as unknown as number[]
    const letter = cmd[0]
    switch (letter) {
      case 'l': x += c[1]!; y += c[2]!; sink.lineTo(x + l, y + t); break
      case 'L': x = c[1]!; y = c[2]!; sink.lineTo(x + l, y + t); break
      case 'h': x += c[1]!; sink.lineTo(x + l, y + t); break
      case 'H': x = c[1]!; sink.lineTo(x + l, y + t); break
      case 'v': y += c[1]!; sink.lineTo(x + l, y + t); break
      case 'V': y = c[1]!; sink.lineTo(x + l, y + t); break
      case 'm': x += c[1]!; y += c[2]!; ax = x; ay = y; sink.moveTo(x + l, y + t); break
      case 'M': x = c[1]!; y = c[2]!; ax = x; ay = y; sink.moveTo(x + l, y + t); break
      case 'c':
        ex = x + c[5]!; ey = y + c[6]!
        cx = x + c[3]!; cy = y + c[4]!
        sink.bezierCurveTo(x + c[1]! + l, y + c[2]! + t, cx + l, cy + t, ex + l, ey + t)
        x = ex; y = ey
        break
      case 'C':
        x = c[5]!; y = c[6]!
        cx = c[3]!; cy = c[4]!
        sink.bezierCurveTo(c[1]! + l, c[2]! + t, cx + l, cy + t, x + l, y + t)
        break
      case 's':
        ex = x + c[3]!; ey = y + c[4]!
        cx = 2 * x - cx; cy = 2 * y - cy
        sink.bezierCurveTo(cx + l, cy + t, x + c[1]! + l, y + c[2]! + t, ex + l, ey + t)
        cx = x + c[1]!; cy = y + c[2]!
        x = ex; y = ey
        break
      case 'S':
        ex = c[3]!; ey = c[4]!
        cx = 2 * x - cx; cy = 2 * y - cy
        sink.bezierCurveTo(cx + l, cy + t, c[1]! + l, c[2]! + t, ex + l, ey + t)
        x = ex; y = ey
        cx = c[1]!; cy = c[2]!
        break
      case 'q':
        ex = x + c[3]!; ey = y + c[4]!
        cx = x + c[1]!; cy = y + c[2]!
        sink.quadraticCurveTo(cx + l, cy + t, ex + l, ey + t)
        x = ex; y = ey
        break
      case 'Q':
        ex = c[3]!; ey = c[4]!
        sink.quadraticCurveTo(c[1]! + l, c[2]! + t, ex + l, ey + t)
        x = ex; y = ey
        cx = c[1]!; cy = c[2]!
        break
      case 't': {
        ex = x + c[1]!; ey = y + c[2]!
        if (previous === null) throw new TypeError("Cannot read properties of null (reading '0')")
        const before = scaledReplay ? 't' : previous
        if (!/[QqTt]/.test(before)) { cx = x; cy = y }
        else if (before === 't') { cx = 2 * x - tcx; cy = 2 * y - tcy }
        else if (before === 'q') { cx = 2 * x - cx; cy = 2 * y - cy }
        tcx = cx; tcy = cy
        sink.quadraticCurveTo(cx + l, cy + t, ex + l, ey + t)
        x = ex; y = ey
        cx = x + c[1]!; cy = y + c[2]!
        break
      }
      case 'T':
        ex = c[1]!; ey = c[2]!
        cx = 2 * x - cx; cy = 2 * y - cy
        sink.quadraticCurveTo(cx + l, cy + t, ex + l, ey + t)
        x = ex; y = ey
        break
      case 'a':
        arcBeziersTo(curve, x + l, y + t, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!, c[6]! + x + l, c[7]! + y + t)
        x += c[6]!; y += c[7]!
        break
      case 'A':
        arcBeziersTo(curve, x + l, y + t, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!, c[6]! + l, c[7]! + t)
        x = c[6]!; y = c[7]!
        break
      case 'z': case 'Z': x = ax; y = ay; sink.closePath(); break
    }
    previous = letter
  }
}

/** A command with its coordinates scaled (an arc's radii and end; its rotation and flags as they are). */
function scaled(cmd: PathCommand, sX: number, sY: number): PathCommand {
  const out: PathCommand = [cmd[0], 0, 0, 0, 0, 0, 0, 0]
  const c = cmd as unknown as number[]
  const o = out as unknown as number[]
  switch (cmd[0]) {
    case 'a': case 'A':
      o[1] = sX * c[1]!; o[2] = sY * c[2]!; o[3] = c[3]!; o[4] = c[4]!; o[5] = c[5]!; o[6] = sX * c[6]!; o[7] = sY * c[7]!
      break
    case 'h': case 'H': o[1] = sX * c[1]!; break
    case 'v': case 'V': o[1] = sY * c[1]!; break
    default: for (let i = 1; i < cmd.length; ++i) o[i] = (i % 2 === 1 ? sX : sY) * c[i]!
  }
  return out
}

/**
 * Replay parsed segments onto a canvas context, offset by (tx, ty). An arc is a canvas arc (a circular one) by default; with
 * `arcs: 'bezier'` it is vega's bezier approximation of an SVG arc (see {@link arcBeziers}).
 */
export function tracePath(ctx: PathSink, segs: PathSeg[], tx = 0, ty = 0, arcs: 'exact' | 'bezier' = 'exact'): void {
  // Track the current point and the last cubic/quadratic control point for
  // S/T smoothing, mirroring the SVG path semantics.
  let cx = 0, cy = 0
  // (where the current subpath began: a close returns the current point there, as SVG's and a canvas's `Z` do)
  let sx = 0, sy = 0
  let lastC: { x: number; y: number } | null = null
  let lastQ: { x: number; y: number } | null = null
  for (const s of segs) {
    switch (s.cmd) {
      case 'M': ctx.moveTo(s.x + tx, s.y + ty); cx = sx = s.x; cy = sy = s.y; lastC = lastQ = null; break
      case 'L': ctx.lineTo(s.x + tx, s.y + ty); cx = s.x; cy = s.y; lastC = lastQ = null; break
      case 'H': ctx.lineTo(s.x + tx, cy + ty); cx = s.x; lastC = lastQ = null; break
      case 'V': ctx.lineTo(cx + tx, s.y + ty); cy = s.y; lastC = lastQ = null; break
      case 'C':
        ctx.bezierCurveTo(s.c1x + tx, s.c1y + ty, s.c2x + tx, s.c2y + ty, s.x + tx, s.y + ty)
        cx = s.x; cy = s.y
        lastC = { x: s.c2x, y: s.c2y }; lastQ = null
        break
      case 'S': {
        const c1 = lastC ? { x: 2 * cx - lastC.x, y: 2 * cy - lastC.y } : { x: cx, y: cy }
        ctx.bezierCurveTo(c1.x + tx, c1.y + ty, s.c2x + tx, s.c2y + ty, s.x + tx, s.y + ty)
        cx = s.x; cy = s.y
        lastC = { x: s.c2x, y: s.c2y }; lastQ = null
        break
      }
      case 'Q':
        ctx.quadraticCurveTo(s.cx + tx, s.cy + ty, s.x + tx, s.y + ty)
        cx = s.x; cy = s.y
        lastQ = { x: s.cx, y: s.cy }; lastC = null
        break
      case 'T': {
        const c: { x: number; y: number } = lastQ ? { x: 2 * cx - lastQ.x, y: 2 * cy - lastQ.y } : { x: cx, y: cy }
        ctx.quadraticCurveTo(c.x + tx, c.y + ty, s.x + tx, s.y + ty)
        cx = s.x; cy = s.y
        lastQ = c; lastC = null
        break
      }
      case 'A': {
        if (arcs === 'bezier') {
          // vega path/render.js drawArc: the arc's beziers, from the current point (a zero radius is a line there too)
          const b = s.rx === 0 || s.ry === 0 || (cx === s.x && cy === s.y) ? [] : arcBeziers(cx, cy, s.rx, s.ry, s.rot, s.large, s.sweep, s.x, s.y)
          if (!b.length) ctx.lineTo(s.x + tx, s.y + ty)
          for (let k = 0; k < b.length; k += 6) ctx.bezierCurveTo(b[k]! + tx, b[k + 1]! + ty, b[k + 2]! + tx, b[k + 3]! + ty, b[k + 4]! + tx, b[k + 5]! + ty)
          cx = s.x; cy = s.y
          lastC = lastQ = null
          break
        }
        // Convert the SVG endpoint arc to canvas arc parameters.
        const x1 = cx, y1 = cy
        const x2 = s.x, y2 = s.y
        const rx = Math.abs(s.rx), ry = Math.abs(s.ry)
        const phi = (s.rot * Math.PI) / 180
        if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
          ctx.lineTo(x2 + tx, y2 + ty)
        } else {
          // Per the SVG spec (F.6.5): convert endpoints to center parameterization.
          const cosP = Math.cos(phi), sinP = Math.sin(phi)
          const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
          const x1p = cosP * dx + sinP * dy
          const y1p = -sinP * dx + cosP * dy
          const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
          // (radii too small for the chord grow to reach it, SVG's rule; a ratio over 1 by rounding alone -- an arc written at half its
          // chord, a trail's cap -- keeps the radius written)
          const scale = lambda > 1 + 1e-12 ? Math.sqrt(lambda) : 1
          const rxp = rx * scale, ryp = ry * scale
          const sign = s.large !== s.sweep ? 1 : -1
          const denom = rxp * rxp * y1p * y1p + ryp * ryp * x1p * x1p
          const cNum = Math.max(0, rxp * rxp * ryp * ryp - denom)
          const cCoef = Math.sqrt(denom > 0 ? cNum / denom : 0) * sign
          const cxp = (cCoef * rxp * y1p) / ryp
          const cyp = (-cCoef * ryp * x1p) / rxp
          const ccx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
          const ccy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
          // Angles from the center to the endpoints (in the rotated frame).
          const ang = (ux: number, uy: number, vx: number, vy: number): number => {
            const dot = ux * vx + uy * vy
            const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
            let a = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))))
            if (ux * vy - uy * vx < 0) a = -a
            return a
          }
          const theta1 = ang(1, 0, (x1p - cxp) / rxp, (y1p - cyp) / ryp)
          let dTheta = ang((x1p - cxp) / rxp, (y1p - cyp) / ryp, (-x1p - cxp) / rxp, (-y1p - cyp) / ryp)
          if (!s.sweep && dTheta > 0) dTheta -= 2 * Math.PI
          if (s.sweep && dTheta < 0) dTheta += 2 * Math.PI
          // canvas arc angles are in the un-rotated frame; rotate the center
          // parameterization angles back by -phi and draw with an ellipse-like
          // transform. Since our geometry only emits circular arcs (rx === ry)
          // or circles, draw via arc with the rotated start angle; for rx===ry
          // the rotation only shifts the start angle by phi.
          const start = theta1 + phi
          const end = start + dTheta
          if (Math.abs(rx - ry) < 1e-9) {
            // (the radius the arc is drawn at: grown to reach the end point when the one written is too small for the chord)
            ctx.arc(ccx + tx, ccy + ty, rxp, start, end, dTheta < 0)
          } else {
            // an elliptical arc: sampled along the ellipse, from its start angle in the ellipse's own frame (the frame's turn is phi)
            traceEllipse(ctx, ccx + tx, ccy + ty, rxp, ryp, phi, theta1, theta1 + dTheta)
          }
        }
        cx = x2; cy = y2
        lastC = lastQ = null
        break
      }
      case 'Z': ctx.closePath(); cx = sx; cy = sy; lastC = lastQ = null; break
    }
  }
}

/**
 * An elliptical arc segment, sampled as short lines: the points at the angles from `start` to `end` of the ellipse of radii (rx, ry)
 * about (cx, cy) turned by `phi`. It goes on from the current point (the arc's start), as the arc it stands for does.
 */
function traceEllipse(ctx: PathSink, cx: number, cy: number, rx: number, ry: number, phi: number, start: number, end: number): void {
  const steps = 64
  const span = end - start
  const n = Math.max(2, Math.ceil((Math.abs(span) / (2 * Math.PI)) * steps))
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  for (let i = 0; i <= n; i++) {
    const a = start + (span * i) / n
    const ex = rx * Math.cos(a), ey = ry * Math.sin(a)
    const x = cx + ex * cosP - ey * sinP
    const y = cy + ex * sinP + ey * cosP
    ctx.lineTo(x, y)
  }
}
