import { createChartSession as createFullSession, type ChartSession } from '@aster-charts/core/dom'

/**
 * `createChartSession` of `@aster-charts/core/dom`, as `@aster-charts/react` exports it: the full engine, so that `evaluate` works for
 * every spec synchronously. A function of its own rather than a re-export, so that an app that never calls it does not carry the
 * parts of the engine the shells load on demand (a bundler keeps the side effects of a module that is only re-exported).
 */
export function createChartSession(): ChartSession {
  return createFullSession()
}
