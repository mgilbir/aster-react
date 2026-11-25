/**
 * The view's own properties (`background`, `autosize`, `padding`, `width`, `height`) as vega reads them. Each is a signal of the
 * view (vega-parser `collectSignals`): its value is the spec's property, else the config's; a `{signal: text}` there is the
 * signal's `update`; and a signal the spec declares under the same name is merged over it (its `value`, `update`, `on` ... win).
 * What the view does with the signal's value is vega-view's: `padding` is read as a padding (vega-view padding.js), `autosize` by
 * its `type` and `contains` (vega-view-transforms viewSizeLayout).
 */
import { specList } from './spec-structure.js'

type Rec = Record<string, unknown>

/** The signals a view has without declaring them, in the order vega-parser makes them. */
export const VIEW_SIGNALS = ['background', 'autosize', 'padding', 'width', 'height'] as const
export type ViewSignal = (typeof VIEW_SIGNALS)[number]

const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
/** vega-util `isObject`: anything typed object but null (an array included). */
const isObject = (v: unknown): v is Rec => v !== null && typeof v === 'object'
/** A `{signal: text}` reference, as vega-parser tells one (`value && value.signal`). */
export const isSignalRef = (v: unknown): v is { signal: string } => isObject(v) && !!(v as Rec).signal

/** The property of the view: the spec's, else the config's (vega-parser `value(spec[name], config[name])`). */
export function viewProperty(spec: Rec, config: Rec, name: ViewSignal): unknown {
  return spec[name] != null ? spec[name] : config[name]
}

export interface Padding { top: number; right: number; bottom: number; left: number }

/** `+_ || 0` (vega's padding number) */
const paddingNumber = (v: unknown): number => +(v as number) || 0

/**
 * A padding as vega-view reads the `padding` signal (padding.js): an object's four sides, each a number or 0; anything else is
 * one number for every side (or 0).
 */
export function paddingOf(v: unknown): Padding {
  if (isObject(v)) {
    return { top: paddingNumber(v.top), right: paddingNumber(v.right), bottom: paddingNumber(v.bottom), left: paddingNumber(v.left) }
  }
  const n = paddingNumber(v)
  return { top: n, right: n, bottom: n, left: n }
}

/** vega-parser parsers/padding.js: the static value of the `padding` signal (a `{signal}` is its update instead). */
function parsePadding(v: unknown): unknown {
  return isSignalRef(v) ? v : paddingOf(v)
}

/** vega-parser parsers/autosize.js: the static value of the `autosize` signal (an object as it is). */
function parseAutosize(v: unknown): unknown {
  return isObject(v) ? v : { type: v || 'pad' }
}

/**
 * The layout the view's autosize makes (vega-view-transforms viewSizeLayout):
 * - `pad`, `fit`, `fit-x`, `fit-y`, `none`: that type;
 * - `skip`: no type at all (a signal holding a string, null or `{}`): the layout returns at once, so the content keeps the view
 *   size the signals give it; with `contains: "padding"` that size still includes the padding (vega-view `viewWidth`);
 * - `shift`: a type that is none of them: the view keeps its size, as for `skip`, but its origin moves by what the content
 *   overflows (the layout runs and matches no case).
 */
export type AutosizeType = 'pad' | 'fit' | 'fit-x' | 'fit-y' | 'none' | 'skip' | 'shift'
export interface Autosize {
  type: AutosizeType
  contains: string | undefined
  /** `resize: true`: the layout sizes the view on every run; else only on the first, and when `width`, `height` or `padding` change. */
  resize?: boolean
}

const TYPES: ReadonlySet<string> = new Set(['pad', 'fit', 'fit-x', 'fit-y', 'none'])

/** The value of the `autosize` signal, read as the layout reads it: by its `type` and `contains`, when it is an object. */
export function autosizeOf(v: unknown): Autosize {
  const type = isObject(v) ? v.type : undefined
  const contains = isObject(v) && typeof v.contains === 'string' ? v.contains : undefined
  const resize = isObject(v) && v.resize === true ? { resize: true } : {}
  if (!type) return { type: 'skip', contains, ...resize }
  return { type: typeof type === 'string' && TYPES.has(type) ? (type as AutosizeType) : 'shift', contains, ...resize }
}

/** The autosize of a view whose `autosize` is no signal: its property (spec, else config) as vega-parser makes it a value. */
export function staticAutosize(v: unknown): Autosize {
  return autosizeOf(parseAutosize(v))
}

/** The static value of a view signal (vega-parser `collectSignals`): what it holds when nothing declares or computes it. */
function staticValue(name: ViewSignal, v: unknown): unknown {
  if (name === 'autosize') return parseAutosize(v)
  if (name === 'padding') return parsePadding(v)
  if (name === 'width' || name === 'height') return v || 0
  return v
}

/**
 * The signals of the view, in the order vega-parser makes them (`collectSignals`): each of the five that the spec declares or that
 * a `{signal}` property of the view makes (its static definition -- `{update}` for a reference, `{value}` otherwise -- with the
 * author's declarations merged over it), then the other signals the spec declares, then those of its config that the spec does
 * not declare. A view signal neither declared nor a reference is left out: its value is the static one.
 */
export function viewSignals(spec: Rec, config: Rec): Rec[] {
  const declared = specList(spec.signals)
  // the author's declaration of each of the five, merged where there are several; the other signals as they come
  let own: Array<Rec | undefined> | undefined
  const others: Rec[] = []
  for (const s of declared) {
    if (!isRecord(s)) continue
    const at = (VIEW_SIGNALS as readonly string[]).indexOf(String(s.name))
    if (at < 0) others.push(s)
    else (own ??= [])[at] = own[at] ? { ...own[at], ...s } : s
  }
  const out: Rec[] = []
  for (let i = 0; i < VIEW_SIGNALS.length; i++) {
    const name = VIEW_SIGNALS[i]!
    const value = viewProperty(spec, config, name)
    const mine = own?.[i]
    if (!isSignalRef(value) && !mine) continue
    const base: Rec = isSignalRef(value) ? { name, update: value.signal } : { name, value: staticValue(name, value) }
    out.push(mine ? { ...base, ...mine } : base)
  }
  for (const s of others) out.push(s)
  const fromConfig = specList(config.signals)
  if (fromConfig.length) {
    const named = new Set(declared.map((d) => (isRecord(d) ? String(d.name) : '')))
    for (const s of fromConfig) if (isRecord(s) && !(VIEW_SIGNALS as readonly string[]).includes(String(s.name)) && !named.has(String(s.name))) out.push(s)
  }
  return out
}
