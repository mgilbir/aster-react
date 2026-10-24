/**
 * The logger the engine reports through, shaped like vega's (`error`/`warn`/`info`/`debug`).
 *
 * vega logs a dataflow error and carries on (default level: warnings and errors to the
 * console); hosts that want to observe those reports -- tests, error trackers, a UI -- pass
 * their own via `RuntimeInput.logger` / `SignalEventHooks.logger`. Nothing in the engine
 * drops an error without going through here.
 */
export interface Logger {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info?(...args: unknown[]): void
  debug?(...args: unknown[]): void
}

/** vega's default: errors and warnings to the console. */
export const consoleLogger: Logger = {
  error: (...args) => { console.error(...args) },
  warn: (...args) => { console.warn(...args) },
}
