/**
 * Port of vega-scenegraph's SVG path machinery (`path/parse.js`, `path/render.js`,
 * `path/arc.js`), used for symbols whose `shape` is a custom SVG path string
 * (vega: `symbols(name)` falls back to `customSymbol(path)`).
 *
 * The path is parsed once, then replayed through a context that re-serializes it
 * with d3-path's formatting (coordinates rounded to 3 decimals, absolute
 * commands, arcs converted to cubic Béziers) scaled by `sqrt(size) / 2`. The
 * OUTPUT is built only from command letters and numbers — nothing of the input
 * text survives into the document, so a hostile `shape` cannot inject markup;
 * its only effects are the numbers it parses to.
 */

const PARAM_COUNTS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, z: 0, c: 6, s: 4, q: 4, t: 2, a: 7 }
const COMMAND_PATTERN = /[mlhvzcsqta]([^mlhvzcsqta]*)/gi
const NUMBER_PATTERN = /^[+-]?(([0-9]*\.[0-9]+)|([0-9]+\.)|([0-9]+))([eE][+-]?[0-9]+)?/
const SPACE_PATTERN = /^((\s+,?\s*)|(,\s*))/
const FLAG_PATTERN = /^[01]/

export type PathCommand = [string, ...number[]]

/** vega `path/parse.js`: throws `Invalid SVG path...` exactly where vega does. */
export function parseSvgPath(path: string): PathCommand[] {
  const commands: PathCommand[] = []
  const matches = path.match(COMMAND_PATTERN) || []
  for (const str of matches) {
    let cmd = str[0]!
    const type = cmd.toLowerCase()
    const paramCount = PARAM_COUNTS[type]!
    const params = parseParams(type, paramCount, str.slice(1).trim())
    const count = params.length
    if (count < paramCount || (count && count % paramCount !== 0)) {
      throw new Error('Invalid SVG path, incorrect parameter count')
    }
    commands.push([cmd, ...params.slice(0, paramCount)])
    if (count === paramCount) continue
    if (type === 'm') cmd = cmd === 'M' ? 'L' : 'l' // implicit line-to
    for (let i = paramCount; i < count; i += paramCount) commands.push([cmd, ...params.slice(i, i + paramCount)])
  }
  return commands
}

function parseParams(type: string, paramCount: number, segment: string): number[] {
  const params: number[] = []
  for (let index = 0; paramCount && index < segment.length;) {
    for (let i = 0; i < paramCount; ++i) {
      const pattern = type === 'a' && (i === 3 || i === 4) ? FLAG_PATTERN : NUMBER_PATTERN
      const match = segment.slice(index).match(pattern)
      if (match === null) throw new Error('Invalid SVG path, incorrect parameter type')
      index += match[0].length
      params.push(+match[0])
      const ws = segment.slice(index).match(SPACE_PATTERN)
      if (ws !== null) index += ws[0].length
    }
  }
  return params
}

const TAU = Math.PI * 2
const HALF_PI = Math.PI / 2
const DEG_TO_RAD = Math.PI / 180

/** vega `path/arc.js` segments (from Inkscape svgtopdf). */
function arcSegments(x: number, y: number, rx: number, ry: number, large: number, sweep: number, rotateX: number, ox: number, oy: number): number[][] {
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
  if (sweep === large) sfactor = -sfactor
  const xc = 0.5 * (x0 + x1) - sfactor * (y1 - y0)
  const yc = 0.5 * (y0 + y1) + sfactor * (x1 - x0)
  const th0 = Math.atan2(y0 - yc, x0 - xc)
  const th1 = Math.atan2(y1 - yc, x1 - xc)
  let thArc = th1 - th0
  if (thArc < 0 && sweep === 1) thArc += TAU
  else if (thArc > 0 && sweep === 0) thArc -= TAU
  const segs = Math.ceil(Math.abs(thArc / (HALF_PI + 0.001)))
  const result: number[][] = []
  for (let i = 0; i < segs; ++i) {
    const th2 = th0 + (i * thArc) / segs
    const th3 = th0 + ((i + 1) * thArc) / segs
    result[i] = [xc, yc, th2, th3, rx, ry, sinTh, cosTh]
  }
  return result
}

/** vega `path/arc.js` bezier. */
function arcBezier(params: number[]): number[] {
  const [cx, cy, th0, th1, rx, ry, sinTh, cosTh] = params as [number, number, number, number, number, number, number, number]
  const a00 = cosTh * rx
  const a01 = -sinTh * ry
  const a10 = sinTh * rx
  const a11 = cosTh * ry
  const cosTh0 = Math.cos(th0)
  const sinTh0 = Math.sin(th0)
  const cosTh1 = Math.cos(th1)
  const sinTh1 = Math.sin(th1)
  const thHalf = 0.5 * (th1 - th0)
  const sinThH2 = Math.sin(thHalf * 0.5)
  const t = ((8 / 3) * sinThH2 * sinThH2) / Math.sin(thHalf)
  const x1 = cx + cosTh0 - t * sinTh0
  const y1 = cy + sinTh0 + t * cosTh0
  const x3 = cx + cosTh1
  const y3 = cy + sinTh1
  const x2 = x3 + t * sinTh1
  const y2 = y3 - t * cosTh1
  return [
    a00 * x1 + a01 * y1, a10 * x1 + a11 * y1,
    a00 * x2 + a01 * y2, a10 * x2 + a11 * y2,
    a00 * x3 + a01 * y3, a10 * x3 + a11 * y3,
  ]
}

/** The drawing surface `renderSvgPath` targets (the subset of a canvas path vega uses). */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
  quadraticCurveTo(x1: number, y1: number, x: number, y: number): void
  closePath(): void
}

function drawArc(sink: PathSink, x: number, y: number, coords: number[]): void {
  const seg = arcSegments(coords[5]!, coords[6]!, coords[0]!, coords[1]!, coords[3]!, coords[4]!, coords[2]!, x, y)
  for (const s of seg) {
    const b = arcBezier(s)
    sink.bezierCurveTo(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!)
  }
}

/** vega `path/render.js`: replay parsed commands into `sink`, scaled by (sX, sY) and offset by (l, t). */
export function renderSvgPath(sink: PathSink, path: PathCommand[], l = 0, t = 0, sX = 1, sY = sX): void {
  let previous: PathCommand | null = null
  let x = 0, y = 0
  let controlX = 0, controlY = 0
  let tempX: number, tempY: number
  let tempControlX = 0, tempControlY = 0
  let anchorX = 0, anchorY = 0

  for (let i = 0; i < path.length; ++i) {
    let current: number[] | PathCommand = path[i]!
    if (sX !== 1 || sY !== 1) current = scaleCommand(current as PathCommand, sX, sY)
    const c = current as unknown as [string, ...number[]] & number[]
    switch (c[0]) {
      case 'l': x += c[1]!; y += c[2]!; sink.lineTo(x + l, y + t); break
      case 'L': x = c[1]!; y = c[2]!; sink.lineTo(x + l, y + t); break
      case 'h': x += c[1]!; sink.lineTo(x + l, y + t); break
      case 'H': x = c[1]!; sink.lineTo(x + l, y + t); break
      case 'v': y += c[1]!; sink.lineTo(x + l, y + t); break
      case 'V': y = c[1]!; sink.lineTo(x + l, y + t); break
      case 'm': x += c[1]!; y += c[2]!; anchorX = x; anchorY = y; sink.moveTo(x + l, y + t); break
      case 'M': x = c[1]!; y = c[2]!; anchorX = x; anchorY = y; sink.moveTo(x + l, y + t); break
      case 'c':
        tempX = x + c[5]!; tempY = y + c[6]!
        controlX = x + c[3]!; controlY = y + c[4]!
        sink.bezierCurveTo(x + c[1]! + l, y + c[2]! + t, controlX + l, controlY + t, tempX + l, tempY + t)
        x = tempX; y = tempY
        break
      case 'C':
        x = c[5]!; y = c[6]!
        controlX = c[3]!; controlY = c[4]!
        sink.bezierCurveTo(c[1]! + l, c[2]! + t, controlX + l, controlY + t, x + l, y + t)
        break
      case 's':
        tempX = x + c[3]!; tempY = y + c[4]!
        controlX = 2 * x - controlX; controlY = 2 * y - controlY
        sink.bezierCurveTo(controlX + l, controlY + t, x + c[1]! + l, y + c[2]! + t, tempX + l, tempY + t)
        controlX = x + c[1]!; controlY = y + c[2]!
        x = tempX; y = tempY
        break
      case 'S':
        tempX = c[3]!; tempY = c[4]!
        controlX = 2 * x - controlX; controlY = 2 * y - controlY
        sink.bezierCurveTo(controlX + l, controlY + t, c[1]! + l, c[2]! + t, tempX + l, tempY + t)
        x = tempX; y = tempY
        controlX = c[1]!; controlY = c[2]!
        break
      case 'q':
        tempX = x + c[3]!; tempY = y + c[4]!
        controlX = x + c[1]!; controlY = y + c[2]!
        sink.quadraticCurveTo(controlX + l, controlY + t, tempX + l, tempY + t)
        x = tempX; y = tempY
        break
      case 'Q':
        tempX = c[3]!; tempY = c[4]!
        sink.quadraticCurveTo(c[1]! + l, c[2]! + t, tempX + l, tempY + t)
        x = tempX; y = tempY
        controlX = c[1]!; controlY = c[2]!
        break
      case 't':
        tempX = x + c[1]!; tempY = y + c[2]!
        if (previous === null || !/[QqTt]/.test(previous[0])) {
          controlX = x; controlY = y
        } else if (previous[0] === 't') {
          controlX = 2 * x - tempControlX; controlY = 2 * y - tempControlY
        } else if (previous[0] === 'q') {
          controlX = 2 * x - controlX; controlY = 2 * y - controlY
        }
        tempControlX = controlX; tempControlY = controlY
        sink.quadraticCurveTo(controlX + l, controlY + t, tempX + l, tempY + t)
        x = tempX; y = tempY
        controlX = x + c[1]!; controlY = y + c[2]!
        break
      case 'T':
        tempX = c[1]!; tempY = c[2]!
        controlX = 2 * x - controlX; controlY = 2 * y - controlY
        sink.quadraticCurveTo(controlX + l, controlY + t, tempX + l, tempY + t)
        x = tempX; y = tempY
        break
      case 'a':
        drawArc(sink, x + l, y + t, [c[1]!, c[2]!, c[3]!, c[4]!, c[5]!, c[6]! + x + l, c[7]! + y + t])
        x += c[6]!; y += c[7]!
        break
      case 'A':
        drawArc(sink, x + l, y + t, [c[1]!, c[2]!, c[3]!, c[4]!, c[5]!, c[6]! + l, c[7]! + t])
        x = c[6]!; y = c[7]!
        break
      case 'z':
      case 'Z':
        x = anchorX; y = anchorY
        sink.closePath()
        break
    }
    previous = path[i]!
  }
}

/** vega render.js `scale` (a fresh array here, not a shared temp). */
function scaleCommand(current: PathCommand, sX: number, sY: number): PathCommand {
  const out: PathCommand = [current[0], 0, 0, 0, 0, 0, 0, 0]
  const c = current[0]
  const cur = current as unknown as number[]
  const o = out as unknown as number[]
  if (c === 'a' || c === 'A') {
    o[1] = sX * cur[1]!
    o[2] = sY * cur[2]!
    o[3] = cur[3]!
    o[4] = cur[4]!
    o[5] = cur[5]!
    o[6] = sX * cur[6]!
    o[7] = sY * cur[7]!
  } else if (c === 'h' || c === 'H') {
    o[1] = sX * cur[1]!
  } else if (c === 'v' || c === 'V') {
    o[1] = sY * cur[1]!
  } else {
    for (let i = 1, n = current.length; i < n; ++i) o[i] = (i % 2 === 1 ? sX : sY) * cur[i]!
  }
  return out
}

const parsedCache = new Map<string, PathCommand[]>()
const PARSE_CACHE_LIMIT = 256

/**
 * The path data of a custom symbol: `shape` parsed as SVG path data and drawn
 * scaled by the symbol radius `r = sqrt(size) / 2` about the origin, serialized
 * the way d3-path does (`num3` rounds to 3 decimals). Throws vega's own error
 * for an invalid path.
 */
export function customSymbolPathData(shape: string, r: number, num3: (v: number) => string): string {
  let parsed = parsedCache.get(shape)
  if (!parsed) {
    parsed = parseSvgPath(shape)
    if (parsedCache.size >= PARSE_CACHE_LIMIT) parsedCache.clear()
    parsedCache.set(shape, parsed)
  }
  let d = ''
  let open = false // d3-path closePath only emits Z after a point exists
  renderSvgPath({
    moveTo: (x, y) => { d += `M${num3(x)},${num3(y)}`; open = true },
    lineTo: (x, y) => { d += `L${num3(x)},${num3(y)}`; open = true },
    bezierCurveTo: (a, b, c, e, x, y) => { d += `C${num3(a)},${num3(b)},${num3(c)},${num3(e)},${num3(x)},${num3(y)}`; open = true },
    quadraticCurveTo: (a, b, x, y) => { d += `Q${num3(a)},${num3(b)},${num3(x)},${num3(y)}`; open = true },
    closePath: () => { if (open) d += 'Z' },
  }, parsed, 0, 0, r)
  return d
}
