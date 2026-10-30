/**
 * Replayable draws for an injected random source (`RuntimeInput.random`).
 *
 * vega runs an operator when its inputs change, and a `random()` calculate draws one number per tuple each time it runs: the
 * numbers are part of the operator's output, and nothing redraws them while the inputs stay what they were (a resize, a signal
 * the dataset does not read). The engine's evaluator is not a reactive dataflow: it reaches a fixed point by building the datasets
 * and resolving the signals more than once in an evaluation, and a chart evaluates again for every size, data or signal change. With
 * `Math.random` that is invisible; with a host-injected stream it would consume the stream once per pass and hand the later passes
 * other numbers than vega's single run gave.
 *
 * So the injected source is wrapped (once per source, for as long as the host keeps passing it): each SITE (a dataset's
 * transform, a signal's update) owns tapes of the numbers it drew, one per fingerprint of what the site reads (its input rows, its
 * parameters, the signals it mentions). Running the site again on the same inputs replays its tape; different inputs are a new
 * run and read the source on from where it stands. That is vega's rule, and it makes the source's consumption the same count, in the
 * same order, as the dataflow's.
 */

export type Random = () => number

/** The numbers one run of a site drew, and the Box-Muller carry-over (`sampleNormal`) the run started with. */
interface Tape { numbers: number[]; pairIn: number | undefined }
interface Site { tapes: Map<string, Tape>; pos: number; tape: Tape | null }

/**
 * The second number of a Box-Muller pair (`sampleNormal`) belongs to the SOURCE it was drawn from: vega keeps it in a module
 * variable, so the pair left by an odd number of calls is the next call's first. Per source here, so views are independent.
 */
export const normalPairs = new WeakMap<Random, number>()

/** Tapes kept per site: a chart driven by a signal visits a new fingerprint every tick, and only the latest runs can come back. */
const TAPES_PER_SITE = 4

interface Tapes { source: Random; sites: Map<string, Site>; current: Site | null }
const BY_SOURCE = new WeakMap<Random, Random>()
const TAPES = new WeakMap<Random, Tapes>()

/** The source an evaluation draws from: replayable per site. The same wrapper for the same source. */
export function replayable(source: Random): Random {
  if (TAPES.has(source)) return source
  const have = BY_SOURCE.get(source)
  if (have !== undefined) return have
  const tapes: Tapes = { source, sites: new Map(), current: null }
  const draw: Random = () => {
    const site = tapes.current
    if (site === null || site.tape === null) return source()
    const { numbers } = site.tape
    if (site.pos < numbers.length) return numbers[site.pos++]!
    const v = source()
    numbers.push(v)
    site.pos++
    return v
  }
  TAPES.set(draw, tapes)
  BY_SOURCE.set(source, draw)
  return draw
}

/**
 * Run `fn` as site `key`, whose inputs are `fingerprint()`: a run of the same site on the same inputs replays what the earlier one
 * drew. A `random` that is not a {@link replayable} one (none, or one a caller passed straight in) is drawn from as it is, and the
 * fingerprint is never computed.
 */
export function atRandomSite<T>(random: Random | undefined, key: string, fingerprint: () => string, fn: () => T): T {
  const tapes = random === undefined ? undefined : TAPES.get(random)
  if (tapes === undefined) return fn()
  let site = tapes.sites.get(key)
  if (site === undefined) tapes.sites.set(key, (site = { tapes: new Map(), pos: 0, tape: null }))
  const fp = fingerprint()
  let tape = site.tapes.get(fp)
  if (tape === undefined) {
    tape = { numbers: [], pairIn: normalPairs.get(random!) }
    site.tapes.set(fp, tape)
    if (site.tapes.size > TAPES_PER_SITE) site.tapes.delete(site.tapes.keys().next().value!)
  } else {
    // a replay starts from the carry-over the first run started with
    site.tapes.delete(fp)
    site.tapes.set(fp, tape)
    if (tape.pairIn === undefined || tape.pairIn !== tape.pairIn) normalPairs.delete(random!)
    else normalPairs.set(random!, tape.pairIn)
  }
  const outer = tapes.current
  const outerState = { pos: site.pos, tape: site.tape }
  site.pos = 0
  site.tape = tape
  tapes.current = site
  try { return fn() } finally {
    tapes.current = outer
    site.pos = outerState.pos
    site.tape = outerState.tape
  }
}

/**
 * What can draw from the injected source: the expression functions that read it (`random`, the three `sample*` distributions), the
 * transforms that do (`sample`, `wordcloud`) and the aggregate ops that bootstrap (`ci0`, `ci1`, in `aggregate`, `joinaggregate`
 * and `window`). Matched as words in the code, so a field that merely shares a name only costs a fingerprint it did not need.
 */
const DRAWING_WORDS = /\b(?:random|sampleNormal|sampleLogNormal|sampleUniform|sample|wordcloud|ci0|ci1)\b/

/**
 * Whether `code` (an expression, or a transform's parameters) could draw from the injected source. A site that cannot has no tape to
 * replay, so its inputs need no fingerprint -- which for a transform over 200k rows is most of what an evaluation would cost.
 */
export function mayDrawRandom(code: unknown): boolean {
  if (typeof code === 'string') return DRAWING_WORDS.test(code)
  if (code === null || typeof code !== 'object') return false
  let may = DRAW_MEMO.get(code)
  if (may === undefined) DRAW_MEMO.set(code, (may = DRAWING_WORDS.test(JSON.stringify(code))))
  return may
}
// (a compiled transform is not changed once built; the memo is by object, so a replaced spec is a new entry)
const DRAW_MEMO = new WeakMap<object, boolean>()

/**
 * A fingerprint of ALL of `v`'s content (rows can be long: {@link valueKey} bounds itself and falls back to identity, which is a miss
 * for the equal copy the next pass makes). Two 32-bit FNV-1a lanes over a typed walk of the value; cyclic or non-plain parts (functions,
 * class instances other than Date) are keyed by identity, which can only be a miss.
 */
export function contentKey(v: unknown): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x9e3779b9
  const seen = new Set<object>()
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 0x01000193)
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) ^ (h2 >>> 13)
    }
  }
  const walk = (x: unknown): void => {
    switch (typeof x) {
      case 'undefined': return mix('u;')
      case 'boolean': return mix(x ? 'T;' : 'F;')
      case 'number': return mix(Object.is(x, -0) ? 'n-0;' : `n${x};`)
      case 'bigint': return mix(`g${x};`)
      case 'string': return mix(`s${x.length}:${x};`)
      case 'symbol': case 'function': return mix(`r${identity(x as object)};`)
    }
    if (x === null) return mix('N;')
    const o = x as object
    if (x instanceof Date) return mix(`d${x.getTime()};`)
    if (seen.has(o)) return mix('c;')
    seen.add(o)
    if (Array.isArray(x)) {
      mix(`a${x.length}[`)
      for (let i = 0; i < x.length; i++) walk(x[i])
      mix(']')
    } else if (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null) {
      const keys = Object.keys(o)
      mix(`o${keys.length}{`)
      for (const k of keys) { mix(`k${k.length}:${k}`); walk((o as Record<string, unknown>)[k]) }
      mix('}')
    } else mix(`r${identity(o)};`)
    seen.delete(o)
  }
  walk(v)
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`
}

const IDENTITIES = new WeakMap<object, number>()
let identitySeq = 0
function identity(o: object): number {
  let id = IDENTITIES.get(o)
  if (id === undefined) IDENTITIES.set(o, (id = ++identitySeq))
  return id
}
