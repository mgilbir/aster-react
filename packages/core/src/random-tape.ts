/**
 * Replayable draws for an injected random source (`RuntimeInput.random`).
 *
 * vega runs each operator once per dataflow run: a `random()` calculate draws one number per tuple, and nothing re-runs
 * it unless its input changes. The engine's evaluator reaches a fixed point instead (it builds the datasets, resolves the
 * signals, builds them again ...), so one evaluation can run the same pipeline more than once. With `Math.random` that is
 * invisible; with a host-injected stream it would consume the stream once per pass and hand the second pass other numbers
 * than vega's single run did.
 *
 * So the injected source is wrapped per evaluation: each SITE (a dataset's pipeline, a signal's update) owns a tape of the
 * numbers it drew; running the site again replays its tape from the start and only reads the source for what the tape does not
 * hold. The source is consumed once per site, in the order the sites first ran: vega's order and count.
 */

export type Random = () => number

interface Site { tape: number[]; pos: number; pair?: number; entered: boolean }

/**
 * The second number of a Box-Muller pair (`sampleNormal`) belongs to the SOURCE it was drawn from: vega keeps it in a module
 * variable, so the pair left by an odd number of calls is the next call's first. Per source here, so views are independent.
 */
export const normalPairs = new WeakMap<Random, number>()

interface Tapes { source: Random; sites: Map<string, Site>; current: Site | null }
const TAPES = new WeakMap<Random, Tapes>()

/** The source an evaluation draws from: replayable per site. The same wrapper for the whole evaluation. */
export function replayable(source: Random): Random {
  const tapes: Tapes = { source, sites: new Map(), current: null }
  const draw: Random = () => {
    const site = tapes.current
    if (site === null) return source()
    if (site.pos < site.tape.length) return site.tape[site.pos++]!
    const v = source()
    site.tape.push(v)
    site.pos++
    return v
  }
  TAPES.set(draw, tapes)
  return draw
}

/**
 * Run `fn` as site `key`: its draws replay the tape of an earlier run of the same site. A `random` that is not a
 * {@link replayable} one (none, or one a caller passed straight in) is drawn from as it is.
 */
export function atRandomSite<T>(random: Random | undefined, key: string, fn: () => T): T {
  const tapes = random === undefined ? undefined : TAPES.get(random)
  if (tapes === undefined) return fn()
  let site = tapes.sites.get(key)
  if (site === undefined) tapes.sites.set(key, (site = { tape: [], pos: 0, entered: false }))
  // the Box-Muller carry-over the site started with (a replay starts from the same state as the first run did)
  if (site.entered) {
    if (site.pair === undefined || site.pair !== site.pair) normalPairs.delete(random!)
    else normalPairs.set(random!, site.pair)
  } else {
    site.pair = normalPairs.get(random!)
    site.entered = true
  }
  const outer = tapes.current
  site.pos = 0
  tapes.current = site
  try { return fn() } finally { tapes.current = outer }
}
