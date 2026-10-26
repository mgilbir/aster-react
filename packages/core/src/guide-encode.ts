/**
 * The encoding half of vega-parser's guides (parsers/guides/*.js and parsers/title.js), as a transcription.
 *
 * A guide is a set of marks (an axis: grid, ticks, labels, domain, title; a legend: gradient or bands or symbols,
 * labels, title; a title: text and subtitle) whose encode blocks vega-parser assembles from the guide spec and the
 * config: `lookup(spec, config)` reads every property (the spec's value, else the config's, else a default -- a `null`
 * in the spec is no value), `addEncoders` puts each present property in the `enter` block (a plain value) or the
 * `update` block (anything that is an encode entry: a signal), the guide's own `encode.<part>` is merged over it
 * (`extendEncode`, block by block), and the config's styles fill what the mark does not encode (`applyDefaults`).
 * A static render then runs `enter`, then `update` over it, against the part's data.
 *
 * Nothing about a property is decided here by name: a property becomes whatever channel the encoder says it is, with
 * the value it has, so `null` (from a signal), a missing value, a number where a word goes, all reach the item the way
 * they reach vega's, and the renderers and the bounds treat the item as they treat any mark's.
 */
import type { EncodeValue, SceneGroup, SceneItem } from './types.js'

export type Row = Record<string, unknown>
type Rec = Record<string, unknown>

/** The scope an expression-like entry (vega: a signal over `datum` / `item`) reads. */
export interface EntryScope {
  host: EntryHost
  datum: Row
  /** the channels of the item evaluated so far (vega: `item`) */
  item: Rec
  /** the guide's group item (vega: `item.mark.group`) */
  group: Rec
}

/** A transcribed signal expression: computed in place of vega's expression text. */
export type EntryFn = (s: EntryScope) => unknown
export type Entry = EncodeValue | EncodeValue[] | EntryFn
export type Block = Record<string, Entry | null | undefined>
export interface MarkEncode {
  enter: Block
  update: Block
  exit?: Block
}
/** The part of a guide's `encode.<part>` that vega's guideMark reads. */
export interface UserEncode {
  name?: unknown
  interactive?: unknown
  style?: unknown
  enter?: Rec
  update?: Rec
  exit?: Rec
  [k: string]: unknown
}

const isObj = (v: unknown): v is object => v === Object(v)
const isArr = Array.isArray
export const isSignal = (v: unknown): v is { signal: string } => !!v && typeof v === 'object' && !isArr(v) && !!(v as { signal?: unknown }).signal

/** vega-parser util `value`: the spec's value unless it is null/undefined. */
export const value = <T>(specValue: T | null | undefined, dflt: T | undefined): T | undefined => (specValue != null ? specValue : dflt)

export const zero: EncodeValue = { value: 0 }
export const one: EncodeValue = { value: 1 }

// --- guides/guide-util.js ------------------------------------------------------------------------------------------

export interface Lookup {
  (name: string, dflt?: unknown): any
  isVertical(symbols?: boolean): boolean
  gradientLength(): any
  gradientThickness(): any
  entryColumns(): any
}

/** vega-parser `lookup(spec, config)`: `_(name, dflt)` is the spec's value, else the config's, else `dflt`. */
export function lookup(spec: Rec, config: Rec): Lookup {
  const _ = ((name: string, dflt?: unknown) => value(spec[name], value(config[name], dflt))) as Lookup
  _.isVertical = (s?: boolean) => 'vertical' === value(spec.direction, (config.direction as unknown) || (s ? config.symbolDirection : config.gradientDirection))
  _.gradientLength = () => value(spec.gradientLength, (config.gradientLength as unknown) || config.gradientWidth)
  _.gradientThickness = () => value(spec.gradientThickness, (config.gradientThickness as unknown) || config.gradientHeight)
  _.entryColumns = () => value(spec.columns, value(config.columns, +_.isVertical(true)))
  return _
}

/** vega-parser `getEncoding`: the value a mark's encode gives a channel (`update`, else `enter`). */
export function getEncoding(name: string, encode: MarkEncode | undefined): unknown {
  const v = encode && ((encode.update && (encode.update[name] as Rec | undefined)) || (encode.enter && (encode.enter[name] as Rec | undefined)))
  return v && (v as { signal?: unknown }).signal ? v : v ? (v as { value?: unknown }).value : null
}

// --- encode/util.js ------------------------------------------------------------------------------------------------

export const encoder = (v: unknown): Rec => (isObj(v) && !isArr(v) && typeof v !== 'function' ? { ...(v as Rec) } : { value: v })

/** vega-parser `addEncode`: a present property goes to `enter` as a value, or to `update` when it is an encode entry. */
export function addEncode(object: MarkEncode, name: string, v: unknown, set: 'enter' | 'update' = 'enter'): number {
  if (v != null) {
    const isEncoder = (isObj(v) && !isArr(v)) || (isArr(v) && v.length > 0 && isObj(v[0]))
    if (isEncoder) object.update[name] = v as Entry
    else object[set][name] = { value: v }
    return 1
  }
  return 0
}

export function addEncoders(object: MarkEncode, enter: Rec, update?: Rec): void {
  for (const name of Object.keys(enter)) addEncode(object, name, enter[name])
  if (update) for (const name of Object.keys(update)) addEncode(object, name, update[name], 'update')
}

const SKIP = new Set(['name', 'style', 'interactive'])

/** vega-parser `extendEncode`: the user's blocks over the guide's, entry by entry. */
export function extendEncode(encode: MarkEncode, extra: UserEncode | undefined, skip = true): MarkEncode {
  if (!extra) return encode
  for (const name of Object.keys(extra)) {
    if (skip && SKIP.has(name)) continue
    if (name !== 'enter' && name !== 'update' && name !== 'exit') continue
    const block = extra[name]
    if (block && typeof block === 'object') {
      const into = ((encode as unknown as Rec)[name] ??= {}) as Rec
      Object.assign(into, block)
    }
  }
  return encode
}

const hasEntry = (key: string, encode: MarkEncode): boolean => !!(encode && ((encode.enter && encode.enter[key]) || (encode.update && encode.update[key])))
export const has = hasEntry

export interface GuideStyles {
  styles: Record<string, Rec | undefined>
  /** `config.lineBreak` */
  lineBreak?: unknown
}

/**
 * vega-parser `applyDefaults`, for a guide mark: its (user-or-guide) style names fill every channel the mark does not
 * encode, from `config.style` (a null in a style is a null channel); a text mark takes `config.lineBreak`. Guide roles
 * take nothing from the mark / group / type configs.
 */
export function applyDefaults(encode: MarkEncode, type: string, style: unknown, cfg: GuideStyles): MarkEncode {
  const defaults: Rec = {}
  const enter: Block = {}
  let update: Block | undefined
  if (type === 'text' && cfg.lineBreak != null && !hasEntry('lineBreak', encode)) applyDefault(defaults, 'lineBreak', cfg.lineBreak)
  for (const name of style == null ? [] : isArr(style) ? style : [style]) {
    const props = cfg.styles[String(name)]
    for (const key of props ? Object.keys(props) : []) {
      if (!hasEntry(key, encode)) applyDefault(defaults, key, props![key])
    }
  }
  const out: MarkEncode = { ...encode }
  for (const key of Object.keys(defaults)) {
    const props = defaults[key] as { signal?: string }
    if (props.signal) (update ??= {})[key] = props as EncodeValue
    else enter[key] = props as EncodeValue
  }
  out.enter = Object.assign(enter, encode.enter)
  if (update) out.update = Object.assign(update, encode.update)
  return out
}

function applyDefault(defaults: Rec, key: string, v: unknown): void {
  defaults[key] = v && (v as { signal?: unknown }).signal ? { signal: (v as { signal: string }).signal } : { value: v }
}

// --- the mark a guide part is ---------------------------------------------------------------------------------------

export interface GuideMarkDef {
  type: 'rule' | 'text' | 'symbol' | 'rect'
  role: string
  /** the style names; a user `encode.<part>.style` replaces it */
  style?: unknown
  encode: MarkEncode
  /** the user's name for the mark (an SVG class token), if any */
  name?: string
  interactive: boolean
  /** the Overlap transform's parameters, if the mark has any */
  overlap?: { separation?: unknown; method?: unknown; order?: string; bound?: { scale: string; orient: string; tolerance: unknown } | null }
}

/** vega-parser `guideMark`: the user's name / style / interactive / encode over what the guide made. */
export function guideMark(mark: GuideMarkDef, extras: UserEncode | undefined): GuideMarkDef {
  if (extras) {
    mark.name = extras.name == null ? undefined : String(extras.name)
    mark.style = extras.style || mark.style
    mark.interactive = !!extras.interactive
    mark.encode = extendEncode(mark.encode, extras, true)
  } else {
    mark.interactive = false
  }
  return mark
}

// --- the evaluator --------------------------------------------------------------------------------------------------

export interface EntryHost {
  /** the generic encode-entry evaluator (value / field / signal / scale / band / mult / offset / round ...) */
  entry(spec: EncodeValue | EncodeValue[], datum: Row): unknown
  /** a signal expression's value */
  expr(code: string): unknown
  /** the view's `width` / `height` signal (what a nested group's grid spans) */
  viewSignal(name: 'width' | 'height'): number
  /** a scale by name (undefined when there is none in scope) */
  scale(name: string): (((v: unknown) => unknown) & { range(): unknown[]; domain(): unknown[] }) | undefined
  /** a failing entry is reported and its channel is left unset */
  report(e: unknown): void
}

/** Run one block: its entries in order, each seeing the item so far. */
export function runBlock(block: Block, item: Rec, datum: Row, group: Rec, host: EntryHost): void {
  for (const key of Object.keys(block)) {
    const e = block[key]
    if (e == null) continue
    let v: unknown
    try {
      v = typeof e === 'function' ? e({ host, datum, item, group }) : host.entry(e as EncodeValue | EncodeValue[], datum)
    } catch (err) {
      host.report(err)
      continue
    }
    // (vega's Encode assigns every channel, an undefined value too: an `update` entry that is undefined clears the `enter` one)
    item[key] = v
  }
}

/**
 * vega-runtime `adjustSpatial`, per block: `x2` / `xc` / `y2` / `yc` become x / y / width / height. A rule keeps its
 * endpoints; a rect swaps so that x / y is the lower edge.
 */
export function adjustSpatial(item: Rec, block: Block, marktype: string): void {
  if (marktype === 'rule') return
  const canSwap = marktype === 'rect' || marktype === 'group' || marktype === 'image'
  const has = (k: string): boolean => block[k] != null
  const n = (k: string): number => item[k] as number
  if (has('x2')) {
    if (has('x')) {
      if (canSwap && n('x') > n('x2')) { const t = item.x; item.x = item.x2; item.x2 = t }
      item.width = n('x2') - n('x')
    } else {
      item.x = n('x2') - (n('width') || 0)
    }
  }
  if (has('xc')) item.x = n('xc') - (n('width') || 0) / 2
  if (has('y2')) {
    if (has('y')) {
      if (canSwap && n('y') > n('y2')) { const t = item.y; item.y = item.y2; item.y2 = t }
      item.height = n('y2') - n('y')
    } else {
      item.y = n('y2') - (n('height') || 0)
    }
  }
  if (has('yc')) item.y = n('yc') - (n('height') || 0) / 2
}

/** One item of a mark: the `enter` block, then the `update` block over it (vega's first Encode pass). */
export function encodeItem(def: GuideMarkDef, datum: Row, group: Rec, host: EntryHost, cfg: GuideStyles): SceneItem {
  const encode = applyDefaults(def.encode, def.type, def.style, cfg)
  const item: Rec = {}
  runBlock(encode.enter, item, datum, group, host)
  adjustSpatial(item, encode.enter, def.type)
  runBlock(encode.update, item, datum, group, host)
  adjustSpatial(item, encode.update, def.type)
  return item as SceneItem
}

/** The aria channels an encoded item gave its element (vega-scenegraph ariaItemAttributes), or undefined when it gave none. */
export function itemAriaOf(item: Rec): SceneGroup['itemAria'] {
  let out: NonNullable<SceneGroup['itemAria']> | undefined
  for (const k of ['description', 'aria', 'ariaRole', 'ariaRoleDescription'] as const) {
    if (item[k] !== undefined) (out ??= {})[k] = item[k] as never
  }
  return out
}

/**
 * vega-encode `DataJoin` with the guide marks' `key: value`: one item per distinct value (the key is the value's string,
 * as in vega-util's fastmap), made where the value first occurs and encoded against the last datum that has it.
 */
export function joinByValue(data: Row[]): Row[] {
  const seen = new Map<string, number>()
  const out: Row[] = []
  for (const d of data) {
    const k = '$' + String(d.value)
    const at = seen.get(k)
    if (at === undefined) {
      seen.set(k, out.length)
      out.push(d)
    } else {
      out[at] = d
    }
  }
  return out
}
