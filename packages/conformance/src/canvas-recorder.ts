/**
 * A recording 2D context for comparing what vega-scenegraph's canvas code draws (its marks' `draw`, its group `pick`) with what Aster's
 * canvas renderer and hit index do, in the same process and without a canvas implementation.
 *
 * It keeps the transform and the current path in device space (to 1e-6, or `digits` decimals), records each paint with the style it used (a gradient as its
 * kind, its device-space coordinates and its stops), and answers `isPointInPath` / `isPointInStroke` from the path's outline (arcs and
 * curves flattened finely; the stroke as every point within half the line width of a segment, its caps as `lineCap` says, which is the
 * canvas's answer away from the joins).
 *
 * `save` / `restore` keep and give back the whole drawing state, as a canvas does (the transform, every style property, the dash and the
 * clip). With `{ state: true }` each paint also carries the rest of what decides its pixels (`Painted.state`): the alpha and the blend, the
 * clip (the device-space paths it was cut by), for a stroke its width, cap, join, miter limit and dash, for a text its font, alignment,
 * baseline and where (and under which linear transform) it was drawn; an arc is then recorded as the curve the canvas draws (see
 * `arcRecord`), whatever angles named it.
 */

type M = [number, number, number, number, number, number]
export interface Painted { op: 'fill' | 'stroke' | 'text'; style: string; path: string; state?: string }

export interface Recorder {
  ctx: never
  painted: Painted[]
}

const ARC_STEPS = 256
const CURVE_STEPS = 32

export function recorder(opts: { state?: boolean; digits?: number } = {}): Recorder {
  const painted: Painted[] = []
  let m: M = [1, 0, 0, 1, 0, 0]
  let dash: number[] = []
  let clips: string[] = []
  const stack: Array<{ m: M; state: Record<string, unknown>; dash: number[]; clips: string[] }> = []
  let path: string[] = []
  // the outline of the current path, its subpaths as device-space point lists
  let polys: Array<{ pts: number[]; closed: boolean }> = []
  let cur: { x: number; y: number } | null = null
  const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, pixelRatio: 1 }
  const scale = 10 ** (opts.digits ?? 6)
  const n = (v: number): string => String(Math.round(v * scale) / scale)
  const tx = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const dev = (x: number, y: number): string => { const [a, b] = tx(x, y); return `${n(a)},${n(b)}` }
  const mul = (b: M): void => {
    m = [m[0] * b[0] + m[2] * b[1], m[1] * b[0] + m[3] * b[1], m[0] * b[2] + m[2] * b[3], m[1] * b[2] + m[3] * b[3], m[0] * b[4] + m[2] * b[5] + m[4], m[1] * b[4] + m[3] * b[5] + m[5]]
  }
  const startSub = (x: number, y: number): void => {
    const [a, b] = tx(x, y)
    polys.push({ pts: [a, b], closed: false })
    cur = { x, y }
  }
  const lineInto = (x: number, y: number): void => {
    if (cur === null) { startSub(x, y); return }
    // (after a close, the next segment begins a new subpath at the closed one's start, as a canvas's `closePath` leaves it)
    if (polys[polys.length - 1]!.closed) startSub(cur.x, cur.y)
    const [a, b] = tx(x, y)
    polys[polys.length - 1]!.pts.push(a, b)
    cur = { x, y }
  }
  // (a gradient as its kind, its coordinates in device space and its stops)
  const gradient = (kind: string) => (...a: number[]): object => {
    const stops: string[] = []
    const at = kind === 'linear' ? `${dev(a[0]!, a[1]!)} ${dev(a[2]!, a[3]!)}` : `${dev(a[0]!, a[1]!)} ${n(a[2]!)} ${dev(a[3]!, a[4]!)} ${n(a[5]!)}`
    return { addColorStop: (o: number, c: string) => { stops.push(`${o}:${c}`) }, toString: () => `${kind}(${at}; ${stops.join(' ')})` }
  }
  // With `{ state: true }`, an arc is recorded as what it draws, at the precision of every other point: the straight line the canvas adds
  // from the current point to the arc's start (or the move to it, with no current point), then `A<end>,<centre>,<radius>,<middle>,<turn>`
  // (the point halfway along it tells which of the two arcs between its ends it is, where a large-arc flag is undecided at a half turn),
  // or `O<centre>,<radius>,<turn>` for a whole circle, with `@<linear part>` under a transform that is not a translation; arcs that go on
  // one from another (one centre, one radius, one turn, the next starting where the last ended) are one arc. The angles that named it
  // are not recorded: two arcs that draw the same curve are the same record.
  let openArc: { index: number; key: string; start: number; end: number; sweep: number } | null = null
  const arcRecord = (cx: number, cy: number, r: number, a0: number, sweep: number): void => {
    const full = 2 * Math.PI
    const linear = [m[0], m[1], m[2], m[3]].map(n).join(',')
    const lin = linear === '1,0,0,1' ? '' : `@${linear}`
    const key = `${dev(cx, cy)},${n(r)}${lin}`
    const start = dev(cx + r * Math.cos(a0), cy + r * Math.sin(a0))
    const wrap = (v: number): number => Math.abs(((v % full) + full + full / 2) % full - full / 2)
    const goesOn = openArc !== null && openArc.index === path.length - 1 && openArc.key === key && Math.sign(openArc.sweep) === Math.sign(sweep)
      && wrap(openArc.end - a0) < 1e-9
    let total = sweep
    let index = path.length
    let arcStart = a0
    if (goesOn) {
      total = Math.max(-full, Math.min(full, openArc!.sweep + sweep))
      index = openArc!.index
      arcStart = openArc!.start
    } else {
      const here = cur === null ? null : dev(cur.x, cur.y)
      if (here === null) path.push(`M${start}`)
      else if (here !== start) path.push(`L${start}`)
      index = path.length
    }
    const turn = total >= 0 ? '+' : '-'
    const text = Math.abs(total) >= full - 1e-9
      ? `O${dev(cx, cy)},${n(r)},${turn}${lin}`
      : `A${dev(cx + r * Math.cos(a0 + sweep), cy + r * Math.sin(a0 + sweep))},${dev(cx, cy)},${n(r)},${dev(cx + r * Math.cos(arcStart + total / 2), cy + r * Math.sin(arcStart + total / 2))},${turn}${lin}`
    path[index] = text
    openArc = { index, key, start: arcStart, end: a0 + sweep, sweep: total }
  }
  // (what else decides the pixels of a paint, with `{ state: true }`)
  const more = (op: Painted['op'], x = 0, y = 0): { state?: string } => {
    if (!opts.state) return {}
    const parts = [`alpha=${n(Number(state.globalAlpha ?? 1))}`, `blend=${String(state.globalCompositeOperation ?? 'source-over')}`]
    if (clips.length) parts.push(`clip=[${clips.join(' | ')}]`)
    if (op === 'stroke') {
      parts.push(`width=${n(Number(state.lineWidth ?? 1))}`, `cap=${String(state.lineCap ?? 'butt')}`, `join=${String(state.lineJoin ?? 'miter')}`, `miter=${n(Number(state.miterLimit ?? 10))}`)
      // (the width is the user space's: under a transform that is not a translation, the linear part scales and turns the pen)
      const pen = [m[0], m[1], m[2], m[3]].map(n).join(',')
      if (pen !== '1,0,0,1') parts.push(`pen=${pen}`)
      if (dash.length) parts.push(`dash=${dash.map(n).join(',')}@${n(Number(state.lineDashOffset ?? 0))}`)
    }
    if (op === 'text') parts.push(`font=${String(state.font ?? '10px sans-serif')}`, `align=${String(state.textAlign ?? 'start')}`, `baseline=${String(state.textBaseline ?? 'alphabetic')}`, `at=${dev(x, y)}`, `linear=${[m[0], m[1], m[2], m[3]].map(n).join(',')}`)
    return { state: parts.join(' ') }
  }
  const own: Record<string, (...a: number[]) => unknown> = {
    save: () => { stack.push({ m: [...m] as M, state: { ...state }, dash: dash.slice(), clips: clips.slice() }) },
    restore: () => {
      const s = stack.pop()
      if (s) {
        m = s.m
        for (const k of Object.keys(state)) if (!(k in s.state)) delete state[k]
        Object.assign(state, s.state)
        dash = s.dash
        clips = s.clips
      }
    },
    setLineDash: ((d: unknown) => { dash = Array.isArray(d) ? d.map(Number) : [] }) as never,
    clip: () => { clips.push(path.join(' ')) },
    translate: (x, y) => mul([1, 0, 0, 1, x!, y!]),
    scale: (x, y) => mul([x!, 0, 0, y!, 0, 0]),
    rotate: (r) => mul([Math.cos(r!), Math.sin(r!), -Math.sin(r!), Math.cos(r!), 0, 0]),
    setTransform: (a, b, c, d, e, f) => { m = [a!, b!, c!, d!, e!, f!] },
    beginPath: () => { path = []; polys = []; cur = null; openArc = null },
    closePath: () => {
      path.push('Z')
      const p = polys[polys.length - 1]
      if (p) { p.closed = true; const [x, y] = [p.pts[0]!, p.pts[1]!]; const inv = invert(m); cur = inv ? { x: inv[0] * x + inv[2] * y + inv[4], y: inv[1] * x + inv[3] * y + inv[5] } : null }
    },
    moveTo: (x, y) => { path.push(`M${dev(x!, y!)}`); startSub(x!, y!) },
    lineTo: (x, y) => { path.push(`L${dev(x!, y!)}`); lineInto(x!, y!) },
    rect: (x, y, w, h) => {
      path.push(`M${dev(x!, y!)}`, `L${dev(x! + w!, y!)}`, `L${dev(x! + w!, y! + h!)}`, `L${dev(x!, y! + h!)}`, 'Z')
      startSub(x!, y!); lineInto(x! + w!, y!); lineInto(x! + w!, y! + h!); lineInto(x!, y! + h!)
      polys[polys.length - 1]!.closed = true
      cur = { x: x!, y: y! }
    },
    arc: (cx, cy, r, a0, a1, ccw) => {
      let sweep = a1! - a0!
      const full = 2 * Math.PI
      if (!ccw) sweep = Math.abs(sweep) >= full ? full : ((sweep % full) + full) % full
      else sweep = Math.abs(sweep) >= full ? -full : -((((a0! - a1!) % full) + full) % full)
      if (opts.state) arcRecord(cx!, cy!, r!, a0!, sweep)
      else {
        path.push(`A${dev(cx!, cy!)} ${n(r!)} ${n(a0!)} ${n(a1!)} ${ccw ? 1 : 0}`)
        openArc = null
      }
      for (let i = 0; i <= ARC_STEPS; i++) {
        const a = a0! + (sweep * i) / ARC_STEPS
        lineInto(cx! + r! * Math.cos(a), cy! + r! * Math.sin(a))
      }
    },
    arcTo: (x1, y1) => { path.push(`T${dev(x1!, y1!)}`); lineInto(x1!, y1!) },
    quadraticCurveTo: (x1, y1, x, y) => {
      path.push(`Q${dev(x1!, y1!)} ${dev(x!, y!)}`)
      const s = cur ?? { x: x1!, y: y1! }
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS, u = 1 - t
        lineInto(u * u * s.x + 2 * u * t * x1! + t * t * x!, u * u * s.y + 2 * u * t * y1! + t * t * y!)
      }
    },
    bezierCurveTo: (x1, y1, x2, y2, x, y) => {
      path.push(`C${dev(x1!, y1!)} ${dev(x2!, y2!)} ${dev(x!, y!)}`)
      const s = cur ?? { x: x1!, y: y1! }
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS, u = 1 - t
        lineInto(u * u * u * s.x + 3 * u * u * t * x1! + 3 * u * t * t * x2! + t * t * t * x!, u * u * u * s.y + 3 * u * u * t * y1! + 3 * u * t * t * y2! + t * t * t * y!)
      }
    },
    createLinearGradient: gradient('linear') as never,
    createRadialGradient: gradient('radial') as never,
    createPattern: () => ({ setTransform: () => undefined, toString: () => 'pattern' }),
    fill: () => { painted.push({ op: 'fill', style: String(state.fillStyle), path: path.join(' '), ...more('fill') }) },
    stroke: () => { painted.push({ op: 'stroke', style: String(state.strokeStyle), path: path.join(' '), ...more('stroke') }) },
    fillText: ((text: unknown, x: number, y: number) => { painted.push({ op: 'text', style: String(state.fillStyle), path: String(text), ...more('text', x, y) }) }) as never,
    // (a stroked text: its outline, with the text's placement and the stroke's width)
    strokeText: ((text: unknown, x: number, y: number) => {
      const s = more('text', x, y)
      painted.push({ op: 'stroke', style: String(state.strokeStyle), path: `text ${String(text)}`, ...(s.state ? { state: `${s.state} width=${n(Number(state.lineWidth ?? 1))}` } : {}) })
    }) as never,
    measureText: ((text: unknown) => ({ width: String(text).length * 6 })) as never,
    // (device-space coordinates, as the canvas takes them; nonzero winding)
    isPointInPath: (x, y) => {
      let wind = 0
      for (const p of polys) {
        const q = p.pts
        for (let i = 0, k = q.length; i < k; i += 2) {
          const ax = q[i]!, ay = q[i + 1]!, bx = q[(i + 2) % k]!, by = q[(i + 3) % k]!
          if (ay <= y!) { if (by > y! && (bx - ax) * (y! - ay) - (x! - ax) * (by - ay) > 0) wind++ }
          else if (by <= y! && (bx - ax) * (y! - ay) - (x! - ax) * (by - ay) < 0) wind--
        }
      }
      return wind !== 0
    },
    isPointInStroke: (x, y) => {
      const h = Number(state.lineWidth) / 2
      const cap = String(state.lineCap ?? 'butt')
      for (const p of polys) {
        const q = p.pts
        const k = q.length
        const segs = p.closed ? k / 2 : k / 2 - 1
        for (let s = 0; s < segs; s++) {
          const i = 2 * s
          const ax = q[i]!, ay = q[i + 1]!, bx = q[(i + 2) % k]!, by = q[(i + 3) % k]!
          const dx = bx - ax, dy = by - ay
          const l = Math.hypot(dx, dy)
          if (l === 0) continue
          const along = ((x! - ax) * dx + (y! - ay) * dy) / l
          const across = Math.abs((x! - ax) * dy - (y! - ay) * dx) / l
          if (along >= 0 && along <= l) { if (across <= h) return true; continue }
          // past an end: a join where the path goes on (taken as round), else the cap
          const end = along < 0 ? 0 : 1
          const open = !p.closed && ((end === 0 && s === 0) || (end === 1 && s === segs - 1))
          const over = along < 0 ? -along : along - l
          if (!open || cap === 'round') { if (Math.hypot(over, across) <= h) return true }
          else if (cap === 'square' && over <= h && across <= h) return true
        }
      }
      return false
    },
  }
  const ctx = new Proxy(state, {
    get: (t, k: string) => (k in own ? own[k] : k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => { t[k] = v; return true },
  })
  return { ctx: ctx as never, painted }
}

function invert(m: M): M | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det) return null
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

type VegaMarks = Record<string, { draw(this: unknown, ctx: unknown, scene: unknown, bounds: unknown, markTypes?: unknown): void }>

/**
 * Draw a vega scenegraph (its root mark) on `ctx` as vega's canvas renderer does: each mark drawn by its own mark type, under its
 * mark-level clip (vega-scenegraph CanvasRenderer.draw), the group items moving the context as they go.
 */
export function vegaDraw(Marks: VegaMarks, ctx: never, root: unknown): void {
  const c = ctx as unknown as { save(): void; restore(): void; beginPath(): void; rect(x: number, y: number, w: number, h: number): void; clip(): void }
  const renderer = {
    draw(context: unknown, scene: { marktype: string; clip?: unknown; group?: { width?: number; height?: number } }, bounds: unknown, markTypes?: unknown): void {
      if (scene.clip) {
        c.save()
        c.beginPath()
        if (typeof scene.clip === 'function') (scene.clip as (x: unknown) => void)(context)
        else c.rect(0, 0, scene.group?.width ?? 0, scene.group?.height ?? 0)
        c.clip()
      }
      Marks[scene.marktype]!.draw.call(renderer, context, scene, bounds, markTypes)
      if (scene.clip) c.restore()
    },
  }
  renderer.draw(ctx, root as never, null)
}
