/**
 * Animated transitions between two scenes (`@aster-charts/core/transition`).
 *
 * `createSceneTransition(from, to)` pairs the items of two scenes of one chart and returns the scenes in between: `at(t)` for
 * a progress `t` in [0, 1] is a scene any renderer draws (`patchSceneDom` for the SVG), and `at(1)` is `to` itself, so a
 * transition always ends on exactly the scene a non-animated update shows. Nothing here schedules time: the host owns the
 * clock (a React chart drives it from `requestAnimationFrame`) and asks for the frame at its progress.
 *
 * Which item becomes which:
 *  - the nodes of a scene (marks, guides, group items) are paired by their place in the tree: by kind, mark type and name,
 *    then in order; the group items of a mark by the mark's `key`, or a facet's `groupby`, when it has one, else in order;
 *  - the items of a mark by the mark's `key` (Vega's `key` property, Vega-Lite's `key` channel) when it has one, else in order
 *    (Vega's own fallback: the index within the mark);
 *  - the grid lines, ticks and labels of an axis by the tick value they stand for, so a tick in both scenes slides.
 *
 * What moves: the numeric geometry and paint of every paired item (position, size, angles, radii, opacities, stroke width,
 * and fill / stroke colours, mixed in RGB) goes from the first scene's value to the second's; anything else (the text, a
 * shape, a path, a gradient, a colour that does not parse) is the second scene's from the start. An item only in `to` enters:
 * a rect whose mark-mates share one baseline grows out of it, anything else fades in. An item only in `from` leaves the
 * opposite way and is gone at the end. A line, area or trail is moved point by point when both scenes have as many points
 * in it; otherwise it is drawn as `to` has it. Legends and titles are drawn as `to` has them.
 *
 * `from` may itself be a frame of a transition (the one on screen when new data arrives): the next transition then starts
 * where the picture is, not where the last one began or would have ended. Neither scene is written to.
 */
import { color } from './color.js'
import { field } from './util.js'
import type { SceneDef, SceneGroup, SceneItem, SceneRoot } from './types.js'

/** The easing curves a transition can name. */
export type EasingName =
  | 'linear'
  | 'quad-in' | 'quad-out' | 'quad-in-out'
  | 'cubic-in' | 'cubic-out' | 'cubic-in-out'
  | 'sin-in' | 'sin-out' | 'sin-in-out'

/** An easing: a named curve, or a function from linear progress in [0, 1] to eased progress (0 at 0 and 1 at 1). */
export type Easing = EasingName | ((t: number) => number)

const EASINGS: Readonly<Record<EasingName, (t: number) => number>> = {
  linear: (t) => t,
  'quad-in': (t) => t * t,
  'quad-out': (t) => t * (2 - t),
  'quad-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  'cubic-in': (t) => t * t * t,
  'cubic-out': (t) => 1 - (1 - t) * (1 - t) * (1 - t),
  'cubic-in-out': (t) => (t < 0.5 ? 4 * t * t * t : 1 - 4 * (1 - t) * (1 - t) * (1 - t)),
  'sin-in': (t) => 1 - Math.cos((t * Math.PI) / 2),
  'sin-out': (t) => Math.sin((t * Math.PI) / 2),
  'sin-in-out': (t) => (1 - Math.cos(Math.PI * t)) / 2,
}

/** The easing names, for a host that validates its options. */
export const EASING_NAMES: readonly EasingName[] = Object.keys(EASINGS) as EasingName[]

/** The function of an easing (default `cubic-in-out`). An unknown name throws a `RangeError`. */
export function easingFunction(easing: Easing = 'cubic-in-out'): (t: number) => number {
  if (typeof easing === 'function') return easing
  const fn = Object.hasOwn(EASINGS, easing) ? EASINGS[easing] : undefined
  if (fn === undefined) throw new RangeError(`[aster] unknown easing ${JSON.stringify(easing)}: use one of ${EASING_NAMES.join(', ')} or a function`)
  return fn
}

export interface SceneTransitionOptions {
  /** Default `cubic-in-out`. */
  easing?: Easing
  /**
   * The most items that may move (data mark items and axis parts that change position, size, opacity or colour; an item that
   * is the same in both scenes does not count). With more, nothing moves: the transition draws `to` at once (`moves` false,
   * `items` more than this), and planning stops as soon as it finds one too many. Default: no limit.
   */
  maxItems?: number
}

export interface SceneTransition {
  readonly from: SceneRoot
  readonly to: SceneRoot
  /** False when nothing would move, or more than `maxItems` would: every frame draws like `to`, and a host can draw `to` at once. */
  readonly moves: boolean
  /** How many items move (when more than `maxItems` would, `maxItems + 1`: planning stopped there). */
  readonly items: number
  /**
   * The scene at linear progress `t` (eased here). `t >= 1` is `to` itself. Below 1 every call returns the SAME scene object,
   * rewritten in place: draw it before asking for the next frame, and do not keep it as a value (use it as the `from` of the
   * next transition, which reads it once, when it is made).
   */
  at(t: number): SceneRoot
}

type Rec = Record<string, unknown>

/** What a paired item interpolates. The opacities default to 1 where an item leaves them unset (it is drawn opaque). */
const NUMERIC = [
  'x', 'y', 'x2', 'y2', 'width', 'height', 'size', 'angle', 'radius', 'innerRadius', 'outerRadius', 'startAngle', 'endAngle',
  'padAngle', 'theta', 'cornerRadius', 'strokeWidth', 'fontSize', 'dx', 'dy', 'opacity', 'fillOpacity', 'strokeOpacity',
] as const
const OPACITY = new Set<string>(['opacity', 'fillOpacity', 'strokeOpacity'])
const PAINT = ['fill', 'stroke'] as const
/** Marks drawn as one shape through all their items: moved point by point. */
const CONNECTED = new Set(['line', 'area', 'trail'])

/** The channels of a transition, as flat columns: a frame is one pass over them. */
/** Thrown by the planner when more items would move than the transition may animate (caught in createSceneTransition). */
const TOO_MANY: unique symbol = Symbol('too many items')

class Channels {
  /** The items with a channel that moves (an item's channels are added together, one item after another). */
  items = 0
  private last: Rec | null = null
  constructor(private readonly maxItems: number) {}
  private moving(obj: Rec): void {
    if (obj === this.last) return
    this.last = obj
    if (++this.items > this.maxItems) throw TOO_MANY
  }
  readonly objs: Rec[] = []
  readonly keys: string[] = []
  readonly start: number[] = []
  readonly delta: number[] = []
  readonly cObjs: Rec[] = []
  readonly cKeys: string[] = []
  /** The colour each channel starts at, as written (the frame at 0 draws exactly it). */
  readonly cFrom: unknown[] = []
  /** r, g, b, alpha per colour channel. */
  readonly cStart: number[] = []
  readonly cDelta: number[] = []

  get size(): number {
    return this.objs.length + this.cObjs.length
  }

  /** `obj[key]` goes from `a` to `b` (and is `a` until the first frame is drawn). */
  num(obj: Rec, key: string, a: number, b: number): void {
    if (a === b) return
    this.moving(obj)
    obj[key] = a
    this.objs.push(obj)
    this.keys.push(key)
    this.start.push(a)
    this.delta.push(b - a)
  }

  /** A colour from `a` to `b`, mixed in RGB; false (nothing added) when either is not a colour both ends can mix. */
  paint(obj: Rec, key: string, a: unknown, b: unknown): boolean {
    const ca = rgbaOf(a)
    const cb = ca && rgbaOf(b)
    if (!ca || !cb) return false
    this.moving(obj)
    obj[key] = a
    this.cObjs.push(obj)
    this.cKeys.push(key)
    this.cFrom.push(a)
    for (let i = 0; i < 4; i++) {
      this.cStart.push(ca[i]!)
      this.cDelta.push(cb[i]! - ca[i]!)
    }
    return true
  }

  apply(e: number): void {
    const { objs, keys, start, delta } = this
    for (let i = 0; i < objs.length; i++) objs[i]![keys[i]!] = start[i]! + delta[i]! * e
    const { cObjs, cKeys, cStart, cDelta, cFrom } = this
    for (let i = 0, j = 0; i < cObjs.length; i++, j += 4) {
      if (e === 0) {
        cObjs[i]![cKeys[i]!] = cFrom[i]
        continue
      }
      const r = byte(cStart[j]! + cDelta[j]! * e)
      const g = byte(cStart[j + 1]! + cDelta[j + 1]! * e)
      const b = byte(cStart[j + 2]! + cDelta[j + 2]! * e)
      const alpha = Math.max(0, Math.min(1, cStart[j + 3]! + cDelta[j + 3]! * e))
      cObjs[i]![cKeys[i]!] = alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${+alpha.toFixed(4)})`
    }
  }
}

const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

/** A paint value as [r, g, b, alpha], or null for what does not mix (a gradient, `none`, `transparent`, an unparsed string). */
function rgbaOf(v: unknown): [number, number, number, number] | null {
  if (typeof v !== 'string') return null
  const c = color(v)
  if (c === null) return null
  const { r, g, b, opacity } = c.rgb()
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(opacity) ? [r, g, b, opacity] : null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A frame's own copy of a scene node: the node's channels, none of the renderer's caches (a copy is never "unchanged"). */
function copyOf(node: SceneItem): Rec {
  const out: Rec = { ...node }
  out.__gen = undefined
  out.__domDesc = undefined
  return out
}

/** Pair the channels of one item: `out` (a copy of `to`) goes from `from`'s values to `to`'s. Returns how many move. */
function tweenItem(ch: Channels, out: Rec, from: Rec, to: Rec): number {
  const before = ch.size
  for (const k of NUMERIC) {
    let a = from[k]
    let b = to[k]
    if (OPACITY.has(k)) {
      if (a === undefined) a = 1
      if (b === undefined) b = 1
    }
    if (finite(a) && finite(b) && a !== b) ch.num(out, k, a, b)
  }
  for (const k of PAINT) {
    const a = from[k]
    const b = to[k]
    if (a !== b) ch.paint(out, k, a, b)
  }
  return ch.size - before
}

/** An item that enters (`fade`: from transparent; a baseline: out of it) or leaves (the reverse). */
function fadeItem(ch: Channels, item: SceneItem, entering: boolean): Rec {
  const out = copyOf(item)
  const o = finite(item.opacity) ? item.opacity : 1
  if (entering) ch.num(out, 'opacity', 0, o)
  else ch.num(out, 'opacity', o, 0)
  return out
}

interface Baseline {
  pos: 'x' | 'y'
  ext: 'width' | 'height'
  end: 'x2' | 'y2'
  at: number
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))

/**
 * The edge every rect of a mark sits on (the zero line of a bar chart), if they share one: the same bottom, top, left or
 * right edge, in that order of preference. Rects that only meet at an edge from both sides (two rows of a heatmap) share
 * none, nor do the segments of a stack.
 */
function baselineOf(items: readonly SceneItem[]): Baseline | null {
  const first = items[0] as Rec | undefined
  if (first === undefined) return null
  const edge = (pos: 'x' | 'y', ext: 'width' | 'height', far: boolean): number | null => {
    const p0 = first[pos]
    const e0 = first[ext]
    if (!finite(p0) || !finite(e0)) return null
    const c = far ? p0 + e0 : p0
    for (const it of items as readonly Rec[]) {
      const p = it[pos]
      const e = it[ext]
      if (!finite(p) || !finite(e) || !near(far ? p + e : p, c)) return null
    }
    return c
  }
  for (const [pos, ext, end, far] of [['y', 'height', 'y2', true], ['y', 'height', 'y2', false], ['x', 'width', 'x2', false], ['x', 'width', 'x2', true]] as const) {
    const at = edge(pos, ext, far)
    if (at !== null) return { pos, ext, end, at }
  }
  return null
}

/** A rect growing out of (or shrinking into) its mark's baseline. */
function growItem(ch: Channels, item: SceneItem, base: Baseline, entering: boolean): Rec {
  const out = copyOf(item)
  const it = item as Rec
  const pairs: Array<[string, number, unknown]> = [[base.pos, base.at, it[base.pos]], [base.ext, 0, it[base.ext]], [base.end, base.at, it[base.end]]]
  for (const [k, edge, own] of pairs) {
    if (!finite(own)) continue
    if (entering) ch.num(out, k, edge, own)
    else ch.num(out, k, own, edge)
  }
  return out
}

/** A value of a key, as a string two scenes can compare (`1` and `'1'` are different keys, as in a Map). */
function keyString(v: unknown): string {
  if (v instanceof Date) return 'd' + v.getTime()
  if (v !== null && typeof v === 'object') {
    try { return 'o' + JSON.stringify(v) } catch { return 'o?' }
  }
  return typeof v + ':' + String(v)
}

/** The key of an item from the values its fields hold in its datum, or undefined (no datum: matched by order). */
function keyReader(fields: readonly string[] | undefined): ((it: SceneItem) => string | undefined) | null {
  if (fields === undefined || fields.length === 0) return null
  let readers: Array<(d: unknown) => unknown>
  try {
    readers = fields.map((f) => field(f) as unknown as (d: unknown) => unknown)
  } catch {
    return null
  }
  return (it) => {
    const d = it.datum
    if (d == null || typeof d !== 'object') return undefined
    let s = ''
    for (const read of readers) {
      let v: unknown
      try { v = read(d) } catch { return undefined }
      s += keyString(v) + '\u0000'
    }
    return s
  }
}

interface Pairing<T> {
  /** For each node of `to`, the node of `from` it continues (null: it enters). */
  matched: Array<T | null>
  /** The nodes of `from` that leave, each after the position in `to` (-1: before the first) its predecessor in `from` went to. */
  leaving: Array<{ node: T; after: number }>
}

/** Pair two lists by a signature (what kind of node) and, within it, by key when both ends have one, else in order. */
function pair<T>(from: readonly T[], to: readonly T[], sig: (n: T) => string, key: (n: T) => string | undefined): Pairing<T> {
  const keyed = new Map<string, number[]>()
  const ordered = new Map<string, number[]>()
  const queue = (m: Map<string, number[]>, k: string): number[] => {
    let q = m.get(k)
    if (q === undefined) m.set(k, (q = []))
    return q
  }
  for (let i = 0; i < from.length; i++) {
    const n = from[i]!
    const s = sig(n)
    const k = key(n)
    queue(k === undefined ? ordered : keyed, k === undefined ? s : s + '\u0001' + k).push(i)
  }
  const placeOf = new Int32Array(from.length).fill(-2)
  const matched: Array<T | null> = new Array(to.length)
  const heads = new Map<number[], number>()
  for (let j = 0; j < to.length; j++) {
    const n = to[j]!
    const s = sig(n)
    const k = key(n)
    const q = (k === undefined ? ordered : keyed).get(k === undefined ? s : s + '\u0001' + k)
    const h = q === undefined ? 0 : heads.get(q) ?? 0
    if (q === undefined || h >= q.length) { matched[j] = null; continue }
    heads.set(q, h + 1)
    const i = q[h]!
    placeOf[i] = j
    matched[j] = from[i]!
  }
  const leaving: Pairing<T>['leaving'] = []
  let after = -1
  for (let i = 0; i < from.length; i++) {
    if (placeOf[i]! >= 0) after = placeOf[i]!
    else leaving.push({ node: from[i]!, after })
  }
  return { matched, leaving }
}

/** The output list: `to`'s order, each leaving node after the place its predecessor went to. */
function interleave<T>(made: T[], leaving: Array<{ node: T; after: number }>, leave: (n: T) => T | null): T[] {
  if (!leaving.length) return made
  const out: T[] = []
  let k = 0
  const flush = (upTo: number): void => {
    while (k < leaving.length && leaving[k]!.after === upTo) {
      const n = leave(leaving[k]!.node)
      if (n !== null) out.push(n)
      k++
    }
  }
  flush(-1)
  for (let j = 0; j < made.length; j++) {
    out.push(made[j]!)
    flush(j)
  }
  return out
}

const isGroup = (n: SceneItem): n is SceneGroup => (n as SceneGroup).marktype !== undefined || Array.isArray((n as SceneGroup).items)

type NodeKind = 'snap' | 'group' | 'mark' | 'leaf' | 'empty'

function kindOf(n: SceneItem): NodeKind {
  if (!isGroup(n)) return 'leaf'
  if (n.emptyMark === true) return 'empty'
  if (n.role === 'legend' || n.role === 'title') return 'snap'
  if (n.marktype === undefined || n.marktype === 'group') return 'group'
  return 'mark'
}

/** What a node is among its siblings: nodes of one signature are paired with each other only. */
function signatureOf(n: SceneItem): string {
  if (!isGroup(n)) return `l|${n._part ?? ''}|${n._kind ?? ''}`
  if (n.emptyMark === true) return `e|${n.markIndex ?? ''}`
  if (n.role === 'axis') return `a|${n.orient ?? ''}|${n.scale ?? ''}`
  if (n.role === 'legend') return `L|${n.legendScale ?? n.scale ?? ''}`
  if (n.marktype === 'group') return `g|${n.markIndex ?? ''}|${n.name ?? ''}|${n.role ?? ''}`
  return `m|${n.marktype ?? ''}|${n.name ?? ''}|${n.role ?? ''}`
}

/** Builds a frame tree once; frames then only rewrite its channels. */
class Planner {
  readonly ch: Channels
  constructor(maxItems: number) { this.ch = new Channels(maxItems) }
  private readonly keyReaders = new Map<string, ReturnType<typeof keyReader>>()

  private readerOf(fields: readonly string[] | undefined): ReturnType<typeof keyReader> {
    if (fields === undefined) return null
    const id = fields.join('\u0000')
    let r = this.keyReaders.get(id)
    if (r === undefined) this.keyReaders.set(id, (r = keyReader(fields)))
    return r
  }

  /** The key of a node among its siblings: a group item's by its key fields, an axis leaf's by its tick value. */
  private nodeKey = (n: SceneItem): string | undefined => {
    if (isGroup(n)) {
      if (n.marktype !== 'group') return undefined
      return this.readerOf(n.__keyFields)?.(n)
    }
    return n.__tick !== undefined ? keyString(n.__tick) : undefined
  }

  /** The children of a container (the root, a group item, an axis): returns `to` itself when nothing in it moves. */
  list(from: readonly SceneItem[], to: readonly SceneItem[], entering: boolean | null): SceneItem[] {
    if (entering !== null) {
      const out: SceneItem[] = []
      for (const n of entering ? to : from) {
        const made = entering ? this.node(null, n) : this.node(n, null)
        if (made !== null) out.push(made)
      }
      return out
    }
    const { matched, leaving } = pair(from, to, signatureOf, this.nodeKey)
    let same = leaving.length === 0
    const made = to.map((t, j) => {
      const n = this.node(matched[j] ?? null, t)!
      if (n !== t) same = false
      return n
    })
    if (same) return to as SceneItem[]
    return interleave(made, leaving, (n) => this.node(n, null))
  }

  /** A node of the frame: `from` null enters, `to` null leaves (null: drawn no more). */
  node(from: SceneItem | null, to: SceneItem | null): SceneItem | null {
    const base = (to ?? from)!
    switch (kindOf(base)) {
      case 'snap':
      case 'empty':
        return to
      case 'leaf':
        if (from !== null && to !== null) {
          const out = copyOf(to)
          return tweenItem(this.ch, out, from as Rec, to as Rec) ? (out as SceneItem) : to
        }
        return fadeItem(this.ch, base, to !== null) as SceneItem
      case 'mark':
        return this.mark(from as SceneGroup | null, to as SceneGroup | null)
      case 'group':
        return this.group(from as SceneGroup | null, to as SceneGroup | null)
    }
  }

  private group(from: SceneGroup | null, to: SceneGroup | null): SceneGroup {
    const base = (to ?? from)!
    const out = copyOf(base) as SceneGroup & Rec
    const own = from !== null && to !== null ? tweenItem(this.ch, out, from as unknown as Rec, to as unknown as Rec) : 0
    const items = this.list((from?.items ?? []) as SceneItem[], (to?.items ?? []) as SceneItem[], from === null ? true : to === null ? false : null)
    if (own === 0 && to !== null && from !== null && items === to.items) return to
    out.items = items as SceneGroup[]
    return out
  }

  private mark(from: SceneGroup | null, to: SceneGroup | null): SceneGroup {
    const base = (to ?? from)!
    const fromItems = (from?.items ?? []) as SceneItem[]
    const toItems = (to?.items ?? []) as SceneItem[]
    const type = base.marktype!
    let items: SceneItem[]
    if (from === null || to === null) {
      // a mark that enters or leaves as a whole: its items do
      const b = type === 'rect' ? baselineOf(to !== null ? toItems : fromItems) : null
      items = (to !== null ? toItems : fromItems).map((it) => (b !== null ? growItem(this.ch, it, b, to !== null) : fadeItem(this.ch, it, to !== null)) as SceneItem)
    } else if (CONNECTED.has(type)) {
      // one shape through its items: point by point when the count is the same, else it is drawn as `to` has it
      if (fromItems.length !== toItems.length) return to
      let moved = false
      items = toItems.map((t, i) => {
        const out = copyOf(t)
        if (tweenItem(this.ch, out, fromItems[i] as Rec, t as Rec) === 0) return t
        moved = true
        return out as SceneItem
      })
      if (!moved) return to
    } else {
      const reader = this.readerOf(to.__keyFields ?? from.__keyFields)
      const key = reader ?? (() => undefined)
      const { matched, leaving } = pair(fromItems, toItems, () => '', key)
      const enterBase = type === 'rect' ? baselineOf(toItems) : null
      const leaveBase = type === 'rect' ? baselineOf(fromItems) : null
      let moved = leaving.length > 0
      const made = toItems.map((t, j) => {
        const f = matched[j]
        if (f == null) {
          moved = true
          return (enterBase !== null ? growItem(this.ch, t, enterBase, true) : fadeItem(this.ch, t, true)) as SceneItem
        }
        const out = copyOf(t)
        if (tweenItem(this.ch, out, f as Rec, t as Rec) === 0) return t
        moved = true
        return out as SceneItem
      })
      if (!moved) return to
      items = interleave(made, leaving, (f) => (leaveBase !== null ? growItem(this.ch, f, leaveBase, false) : fadeItem(this.ch, f, false)) as SceneItem)
    }
    const out = copyOf(base) as SceneGroup & Rec
    out.items = items as SceneGroup[]
    return out
  }
}

/** The gradients of both scenes: a leaving item may still be painted with one only `from` defines. */
function mergedDefs(to: SceneRoot, from: SceneRoot): SceneDef[] | undefined {
  if (!from.defs?.length) return to.defs
  const ids = new Set((to.defs ?? []).map((d) => d.id))
  const extra = from.defs.filter((d) => !ids.has(d.id))
  return extra.length ? [...(to.defs ?? []), ...extra] : to.defs
}

/**
 * The transition from scene `from` to scene `to` (two evaluations of one chart, or a frame of a running transition and the
 * next scene). See the module comment for what is paired and how it moves.
 */
export function createSceneTransition(from: SceneRoot, to: SceneRoot, options: SceneTransitionOptions = {}): SceneTransition {
  const ease = easingFunction(options.easing)
  if (from === to) return { from, to, moves: false, items: 0, at: () => to }
  const maxItems = options.maxItems ?? Infinity
  const planner = new Planner(maxItems >= 0 ? maxItems : 0)
  let items: SceneItem[]
  try {
    items = planner.list(from.items as SceneItem[], to.items as SceneItem[], null)
  } catch (e) {
    if (e === TOO_MANY) return { from, to, moves: false, items: planner.ch.items, at: () => to }
    throw e
  }
  const ch = planner.ch
  if (ch.size === 0) return { from, to, moves: false, items: 0, at: () => to }
  // (the root's own drawing is `to`'s; the item generation stays `to`'s, so the items of `to` a frame draws unchanged keep
  // their cached descriptors, while the frame's own copies, which have no generation, are always drawn afresh)
  const frame = { ...to, items: items as SceneGroup[] } as SceneRoot
  const defs = mergedDefs(to, from)
  if (defs !== undefined) frame.defs = defs
  return {
    from,
    to,
    moves: true,
    items: ch.items,
    at(t: number): SceneRoot {
      if (!(t < 1)) return to
      ch.apply(ease(t > 0 ? t : 0))
      return frame
    },
  }
}

/** How a player animates one change: its duration (ms) and easing. */
export interface PlayOptions {
  duration: number
  easing?: Easing
  /** See `SceneTransitionOptions.maxItems`: a change that would move more items is drawn at once. */
  maxItems?: number
}

/** Draws the scenes of one chart into its target (an `<svg>`), at once or as a transition from what is on screen. */
export interface ScenePlayer<T> {
  /**
   * Draw `scene` into `target`. With `animate`, a transition from the picture on screen (the last scene drawn, or the frame of
   * the transition this one interrupts) to `scene`. Without it, a running transition takes `scene` as its new end on the same
   * clock (the marks keep moving and land on it); otherwise `scene` is drawn at once.
   */
  draw(target: T, scene: SceneRoot, animate: PlayOptions | null): void
  /** The target shows `scene` (it was drawn some other way): stop any transition; the next one starts from it. */
  reset(scene: SceneRoot | null): void
  /** Stop requesting frames (the target keeps the frame it shows). */
  cancel(): void
}

interface Playing<T> {
  target: T
  /** Where it started: kept, so a change that only retargets it keeps its start and its clock. */
  from: SceneRoot
  to: SceneRoot
  tr: SceneTransition
  t0: number
  duration: number
  easing: Easing | undefined
  maxItems: number | undefined
}

/**
 * A frame loop over `requestAnimationFrame` that draws transitions with `paint` (`patchSceneDom` for an `<svg>`). `shown` is
 * what the target shows now. Where there is no `requestAnimationFrame` (a server), every scene is drawn at once.
 */
export function createScenePlayer<T>(
  paint: (target: T, scene: SceneRoot) => void,
  report: (error: Error) => void,
  shown: SceneRoot | null = null,
): ScenePlayer<T> {
  let run: Playing<T> | null = null
  let frame = 0
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const stopFrames = (): void => {
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
  }
  const settle = (target: T, scene: SceneRoot): void => {
    stopFrames()
    run = null
    paint(target, scene)
    shown = scene
  }
  const show = (r: Playing<T>, t: number): void => {
    const scene = r.tr.at(t)
    paint(r.target, scene)
    shown = scene
  }
  const progress = (r: Playing<T>): number => (r.duration > 0 ? (now() - r.t0) / r.duration : 1)
  const tick = (): void => {
    frame = 0
    const r = run
    if (r === null) return
    const t = progress(r)
    if (t >= 1) {
      settle(r.target, r.to)
      return
    }
    try {
      show(r, t)
    } catch (e) {
      report(e instanceof Error ? e : new Error(String(e)))
      settle(r.target, r.to)
      return
    }
    frame = requestAnimationFrame(tick)
  }
  /** The transition, or null when nothing would move (or it cannot be made: reported). */
  const make = (from: SceneRoot, to: SceneRoot, easing: Easing | undefined, maxItems: number | undefined): SceneTransition | null => {
    try {
      const tr = createSceneTransition(from, to, { easing, ...(maxItems !== undefined ? { maxItems } : {}) })
      return tr.moves ? tr : null
    } catch (e) {
      report(e instanceof Error ? e : new Error(String(e)))
      return null
    }
  }
  return {
    draw(target, scene, animate) {
      if (typeof requestAnimationFrame !== 'function') {
        settle(target, scene)
        return
      }
      if (animate !== null) {
        const from = shown
        if (animate.duration > 0 && from !== null) {
          const tr = make(from, scene, animate.easing, animate.maxItems)
          if (tr !== null) {
            stopFrames()
            run = { target, from, to: scene, tr, t0: now(), duration: animate.duration, easing: animate.easing, maxItems: animate.maxItems }
            show(run, 0)
            frame = requestAnimationFrame(tick)
            return
          }
        }
      } else if (run !== null && run.target === target) {
        const r = run
        const tr = make(r.from, scene, r.easing, r.maxItems)
        const t = progress(r)
        if (tr !== null && t < 1) {
          r.tr = tr
          r.to = scene
          show(r, t)
          return
        }
      }
      settle(target, scene)
    },
    reset(scene) {
      stopFrames()
      run = null
      shown = scene
    },
    cancel() {
      stopFrames()
      run = null
    },
  }
}
