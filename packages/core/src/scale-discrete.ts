/**
 * The scales over categories and bins: ordinal (a list of categories onto a list of values), band and point (categories
 * onto evenly spaced positions along a range). Bin-ordinal and the discretizing quantile, quantize and threshold scales, which cut
 * a continuous domain into classes, are scale-classes.ts' (the engine's `scales` part); what they show is listed here too.
 *
 * What the callers observe, and so what is fixed here:
 * - categories are identified by value: two Dates of one instant are one category, a number and its string are two;
 * - an ordinal scale that has not been told what an unknown category maps to adds it to its domain on first sight (the
 *   `implicit` setting), so the domain read back after drawing lists every category drawn;
 * - a band scale divides its range into `n` steps of `(range) / (n - padding_inner + 2 * padding_outer)` with the leftover
 *   shifted by `align`, rounding the step, the start and the band to whole units when asked, and a reversed range lists
 *   the same bands from the far end;
 * - a threshold or quantize scale answers with the class a value falls in by binary search, `undefined` for the missing;
 * - `quantize.unknown()` called with no argument returns the scale itself, not the value: the pinned oracle does, and a
 *   caller that reads it back sees a function.
 */
import { bisectRight, InternMap, range as sequence } from './arr.js'
import type { ScaleObject } from './scale-continuous.js'

export const implicit = Symbol('implicit')

// ---- categories --------------------------------------------------------------------------------------------

/** The ordered categories of a scale, the position of each, and the values they map to. */
class Lexicon {
  names: unknown[] = []
  positions = new InternMap<unknown, number>()
  values: unknown[] = []
  fallback: unknown

  constructor(fallback: unknown) {
    this.fallback = fallback
  }

  /** The value of a category; an unseen one is the fallback, or (when the fallback is `implicit`) joins the domain. */
  at(key: unknown): unknown {
    let position = this.positions.get(key)
    if (position === undefined) {
      if (this.fallback !== implicit) return this.fallback
      this.positions.set(key, (position = this.names.push(key) - 1))
    }
    return this.values[position % this.values.length]
  }

  // (the parameter is called `_` because the engine's message for a value that is not iterable quotes the name it was given)
  setNames(_: Iterable<unknown>): void {
    this.names = []
    this.positions = new InternMap()
    for (const key of _) {
      if (this.positions.has(key)) continue
      this.positions.set(key, this.names.push(key) - 1)
    }
  }
}

export function ordinal(): ScaleObject {
  const lexicon = new Lexicon(implicit)
  const scale = ((key: unknown) => lexicon.at(key)) as ScaleObject
  scale.domain = (...v: [Iterable<unknown>?]) => (v.length ? (lexicon.setNames(v[0]!), scale) : lexicon.names.slice())
  scale.range = (...v: [Iterable<unknown>?]) => (v.length ? ((lexicon.values = Array.from(v[0]!)), scale) : lexicon.values.slice())
  scale.unknown = (...v: [unknown?]) => (v.length ? ((lexicon.fallback = v[0]), scale) : lexicon.fallback)
  scale.copy = () => ordinal().domain(lexicon.names).range(lexicon.values).unknown(lexicon.fallback)
  return scale
}

// ---- bands and points --------------------------------------------------------------------------------------

/** The number of steps a band layout divides its range into (zero for no categories; never below one otherwise). */
export function bandSpace(count: number, paddingInner: number, paddingOuter: number): number {
  const space = count - paddingInner + paddingOuter * 2
  return count ? (space > 0 ? space : 1) : 0
}

const unitClamp = (v: number): number => Math.max(0, Math.min(1, v))

/**
 * Bands (a point scale is a band scale whose inner padding is fixed at one and whose single `padding` is the outer).
 * The positions of the bands are recomputed whenever the domain, the range or a padding changes.
 */
function bands(point: boolean): ScaleObject {
  const lexicon = new Lexicon(undefined)
  const scale = ((key: unknown) => lexicon.at(key)) as ScaleObject
  let extent: [number, number] = [0, 1]
  let step = 0
  let bandwidth = 0
  let round = false
  let paddingInner = point ? 1 : 0
  let paddingOuter = 0
  let align = 0.5

  const reversed = (): boolean => extent[1] < extent[0]

  const layout = (): void => {
    const n = lexicon.names.length
    const flip = reversed()
    const stop = extent[flip ? 0 : 1]
    let start = extent[flip ? 1 : 0]
    step = (stop - start) / (bandSpace(n, paddingInner, paddingOuter) || 1)
    if (round) step = Math.floor(step)
    start += (stop - start - step * (n - paddingInner)) * align
    bandwidth = step * (1 - paddingInner)
    if (round) {
      start = Math.round(start)
      bandwidth = Math.round(bandwidth)
    }
    const starts = sequence(n).map((i) => start + step * i)
    lexicon.values = flip ? starts.reverse() : starts
  }
  // each member that changes the layout recomputes it after writing
  scale.domain = (...v: [Iterable<unknown>?]) => (v.length ? (lexicon.setNames(v[0]!), layout(), scale) : lexicon.names.slice())
  scale.range = (...v: [ArrayLike<unknown>?]) => (v.length ? ((extent = [+(v[0]![0] as number), +(v[0]![1] as number)]), layout(), scale) : extent.slice())
  scale.rangeRound = (...v: [ArrayLike<unknown>]) => {
    extent = [+(v[0][0] as number), +(v[0][1] as number)]
    round = true
    layout()
    return scale
  }
  scale.bandwidth = () => bandwidth
  scale.step = () => step
  scale.round = (...v: [unknown?]) => (v.length ? ((round = !!v[0]), layout(), scale) : round)
  scale.align = (...v: [number?]) => (v.length ? ((align = unitClamp(v[0]!)), layout(), scale) : align)
  scale.paddingOuter = (...v: [number?]) => (v.length ? ((paddingOuter = unitClamp(v[0]!)), layout(), scale) : paddingOuter)
  if (point) {
    scale.padding = scale.paddingOuter
  } else {
    scale.paddingInner = (...v: [number?]) => (v.length ? ((paddingInner = unitClamp(v[0]!)), layout(), scale) : paddingInner)
    scale.padding = (...v: [number?]) => (v.length ? ((paddingOuter = paddingInner = unitClamp(v[0]!)), layout(), scale) : paddingInner)
  }

  /** The categories whose bands the span [a, b] of the range touches; undefined when it touches none. */
  scale.invertRange = (span: ArrayLike<unknown>) => {
    if (span[0] == null || span[1] == null) return undefined
    const flip = reversed()
    const starts = lexicon.values.slice() as number[]
    if (flip) starts.reverse()
    const last = starts.length - 1
    let lo = +(span[0] as number)
    let hi = +(span[1] as number)
    if (lo !== lo || hi !== hi) return undefined
    if (hi < lo) [lo, hi] = [hi, lo]
    if (hi < starts[0]! || lo > extent[flip ? 0 : 1]) return undefined
    let first = Math.max(0, bisectRight(starts, lo) - 1)
    let end = lo === hi ? first : bisectRight(starts, hi) - 1
    // a start inside the gap after a band belongs to the next one
    if (lo - starts[first]! > bandwidth + 1e-10) ++first
    if (flip) [first, end] = [last - end, last - first]
    return first > end ? undefined : lexicon.names.slice(first, end + 1)
  }
  scale.invert = (position: unknown) => {
    const hit = scale.invertRange([position, position])
    return hit ? hit[0] : hit
  }
  scale.copy = () => {
    const twin = bands(point)
    twin.domain(lexicon.names).range(extent).round(round).paddingOuter(paddingOuter).align(align)
    if (!point) twin.paddingInner(paddingInner)
    return twin
  }
  layout()
  return scale
}

export const band = (): ScaleObject => bands(false)
export const point = (): ScaleObject => bands(true)
