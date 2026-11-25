/**
 * The logger the engine reports through, shaped like vega's (`error`/`warn`/`info`/`debug`).
 *
 * vega logs a dataflow error through its logger and carries on; hosts that want to observe those reports -- tests, error trackers, a UI -- pass
 * their own via `RuntimeInput.logger` / `SignalEventHooks.logger`. Nothing in the engine
 * drops an error without going through here.
 */
export interface Logger {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info?(...args: unknown[]): void
  debug?(...args: unknown[]): void
}

/** Errors and warnings to the console (what vega-embed's logger prints; vega-util's own default logger prints nothing). */
export const consoleLogger: Logger = {
  error: (...args) => { console.error(...args) },
  warn: (...args) => { console.warn(...args) },
}

/**
 * The logger an evaluation reports to: the host's, with any of `error` / `warn` it did not give (a JavaScript caller's `{ error }`,
 * `{}`) answered by the console, so a partial logger never turns the report of an error into a TypeError of its own.
 */
export function loggerOf(logger: Logger | undefined): Logger {
  if (logger === undefined) return consoleLogger
  if (typeof logger.error === 'function' && typeof logger.warn === 'function') return logger
  return {
    ...logger,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : consoleLogger.error,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : consoleLogger.warn,
  }
}
