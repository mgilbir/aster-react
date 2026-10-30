/**
 * Event selector strings, as Vega signals and Vega-Lite selections write them: `click`, `window:keydown!`,
 * `rect:mouseover[event.shiftKey]{10}`, `@brush:pointermove`, `[pointerdown, pointerup] > pointermove`, merged with
 * commas. `parseEventSelectorString` turns one into the list of stream definitions that the signal event loop and the
 * Vega-Lite compiler work with.
 *
 * A stream is `[qualifier:]type[!][filter]...[{throttle[,debounce]}]`; the qualifier names an event source
 * (`window`, `#id`, ...), a mark type (`rect`) or, after `@`, a mark name. A "between" selector `[a, b] > c` limits `c`
 * to the time between `a` and `b`. A string that is not valid fails with an `Error` whose message names the problem
 * and quotes the text; those messages are part of the contract (a user sees them in a spec error).
 *
 * `@aster/vl` carries a byte-identical copy of this module (it must not depend on the engine); a conformance test
 * keeps the two equal and compares both with the reference parser.
 */

export interface StreamDef {
  source?: string
  type?: string
  markname?: string
  marktype?: string
  filter?: string | string[]
  throttle?: number
  debounce?: number
  consume?: boolean
  between?: StreamDef[]
  /** The stream a between selector wraps when that stream is itself a between selector. */
  stream?: StreamDef
  merge?: StreamDef[]
}

/** The mark types a qualifier can name when the caller does not say otherwise. */
const MARK_TYPES: Record<string, true> = {
  '*': true, arc: true, area: true, group: true, image: true, line: true, path: true, rect: true, rule: true, shape: true, symbol: true, text: true, trail: true,
}

interface Context {
  /** The source of a stream that names none. */
  source: string
  marks: Record<string, unknown>
}

function fail(message: string): never {
  throw new Error(message)
}

/**
 * Parse an event selector. `source` is what a stream without a qualifier listens to (default `view`); `marks` is the
 * set of names that count as mark types (default: the Vega mark types).
 */
export function parseEventSelectorString(selector: string, source?: string, marks?: Record<string, unknown>): StreamDef[] {
  const context: Context = { source: source || 'view', marks: marks || MARK_TYPES }
  return splitMerge(selector.trim()).map((part) => parseSelector(part, context))
}

/**
 * Index of the first `stop` at nesting depth 0 from `from`, or the text length. Characters of `opens` raise the depth
 * and those of `closes` lower it; a closer without an opener takes the depth below 0 and keeps later stops hidden.
 */
function findTopLevel(text: string, from: number, stop: string, opens = '', closes = ''): number {
  let depth = 0
  let i = from
  for (; i < text.length; i++) {
    const c = text[i]!
    if (depth === 0 && c === stop) return i
    if (closes.includes(c)) depth--
    else if (opens.includes(c)) depth++
  }
  return i
}

/** The comma-separated selectors of a merge, each trimmed; a trailing comma adds nothing. */
function splitMerge(text: string): string[] {
  const parts: string[] = []
  for (let start = 0; start < text.length;) {
    const end = findTopLevel(text, start, ',', '[{', ']}')
    parts.push(text.slice(start, end).trim())
    start = end + 1
  }
  if (!parts.length) fail('Empty event selector: ' + text)
  return parts
}

function parseSelector(text: string, context: Context): StreamDef {
  return text[0] === '[' ? parseBetween(text, context) : parseStream(text, context)
}

function parseBetween(text: string, context: Context): StreamDef {
  const close = findTopLevel(text, 1, ']', '[', ']')
  if (close === text.length) fail('Empty between selector: ' + text)
  const ends = splitMerge(text.slice(1, close))
  if (ends.length !== 2) fail('Between selector must have two elements: ' + text)
  const after = text.slice(close + 1).trim()
  if (after[0] !== '>') fail("Expected '>' after between selector: " + after)
  const between = ends.map((end) => parseSelector(end, context))
  const stream = parseSelector(after.slice(1).trim(), context)
  if (stream.between) return { between, stream }
  stream.between = between
  return stream
}

/** The `throttle[,debounce]` numbers between braces, or undefined if they are not one or two numbers. */
function readDelays(text: string): [number, number | undefined] | undefined {
  const items = text.split(',')
  if (!text.length || items.length > 2) return undefined
  const numbers = items.map(Number)
  return numbers.some((x) => Number.isNaN(x)) ? undefined : [numbers[0]!, numbers[1]]
}

/** The filter expressions of `[a][b]`, from the `[` at `open`. */
function readFilters(text: string, open: number): string[] {
  const filters: string[] = []
  const end = text.length
  let pos = open + 1
  if (pos === end) fail('Unmatched left bracket: ' + text)
  while (pos < end) {
    const close = text.indexOf(']', pos)
    if (close < 0) fail('Unmatched left bracket: ' + text)
    filters.push(text.slice(pos, close).trim())
    if (close < end - 1 && text[close + 1] !== '[') fail('Expected left bracket: ' + text)
    pos = close + 2
  }
  return filters
}

function parseStream(text: string, context: Context): StreamDef {
  let body = text
  let throttle = 0
  let debounce: number | undefined = 0
  if (body.endsWith('}')) {
    const brace = body.lastIndexOf('{')
    if (brace < 0) fail('Unmatched right brace: ' + body)
    const delays = readDelays(body.slice(brace + 1, -1))
    if (!delays) fail('Invalid throttle specification: ' + body)
    ;[throttle, debounce] = delays
    body = body.slice(0, brace).trim()
  }
  if (!body) fail(body)

  const named = body[0] === '@'
  const colon = body.indexOf(':', named ? 1 : 0)
  const qualifier = colon < 0 ? undefined : body.slice(0, colon).trim()
  const typeStart = colon < 0 ? 0 : colon + 1
  const bracket = body.indexOf('[', colon < 0 ? (named ? 1 : 0) : typeStart)
  const typeText = body.slice(typeStart, bracket < 0 ? undefined : bracket).trim()
  const filter = bracket < 0 ? undefined : readFilters(body, bracket)
  if (/[[\]{}]/.test(typeText)) fail('Invalid event selector: ' + body)

  const stream: StreamDef = { source: context.source, type: typeText }
  if (qualifier !== undefined) {
    if (named) stream.markname = qualifier.slice(1)
    else if (Object.hasOwn(context.marks, qualifier)) stream.marktype = qualifier
    else stream.source = qualifier
  }
  if (typeText.endsWith('!')) {
    stream.consume = true
    stream.type = typeText.slice(0, -1)
  }
  if (filter) stream.filter = filter
  if (throttle) stream.throttle = throttle
  if (debounce) stream.debounce = debounce
  return stream
}
