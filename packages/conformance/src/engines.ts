/**
 * One spec, two engines: each engine gets a copy of its own.
 *
 * Vega ingests the rows of an inline dataset WITHOUT copying them, and its transforms write their answers onto those rows
 * (`stack` writes y0/y1, `pie` startAngle/endAngle, `bin` bin0/bin1, `geopoint` x/y, `force` the link rows...). A harness
 * that renders the oracle first and then hands Aster the same spec object hands Aster the oracle's answers: an Aster that
 * runs no transform at all then "agrees". The same holds for rows shared through any other path (a generator's module-level
 * table used by every case, a Vega-Lite spec whose compiled Vega keeps the input's `values` array, a dataset the test also
 * gives `view.insert`).
 *
 * `forEngines(spec, fn)` is the one place a harness turns a case into what each engine reads: two deep copies taken BEFORE
 * either engine runs, so neither sees what the other wrote, whatever the order or concurrency the harness runs them in.
 * The case itself can then be deep-frozen (`deepFreeze`): a harness path that hands the frozen original to vega fails loudly
 * (vega's write throws in strict mode) instead of quietly sharing it.
 *
 * scripts/engine-sharing.setup.mjs holds every conformance test to this at run time: it fails a test that hands an object
 * one engine has read (or written) to the other.
 */

export type Spec = Record<string, unknown>

/** A deep copy that keeps what JSON cannot (-0, NaN, Infinity, Dates, undefined members). */
function copy<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Hand `fn` one copy of `spec` for the oracle and another for Aster, both taken before either runs.
 * The copies share nothing with `spec` or with each other.
 */
export function forEngines<R, S = Spec>(spec: S, fn: (oracle: S, aster: S) => R): R {
  return fn(copy(spec), copy(spec))
}

/** Freeze a value and everything reachable from it (a generated case or a corpus spec: the source both engines copy from). */
export function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value]
  while (stack.length) {
    const v = stack.pop()
    if (v === null || typeof v !== 'object' || Object.isFrozen(v)) continue
    Object.freeze(v)
    for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k])
  }
  return value
}
