/**
 * A spec that vega's parser (`vega.parse`) refuses outright: it throws before any view exists, so nothing is
 * drawn. The engine parses and evaluates in one pass, but these stay throws -- they are not the "log and carry
 * on" errors of a running dataflow (see RuntimeInput.logger): the spec itself is wrong, not one datum.
 */
export class SpecParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SpecParseError'
  }
}
