/**
 * Event selector parser: a port of `vega-event-selector` (v4), which turns a
 * selector string such as `[mousedown, mouseup] > mousemove[event.shiftKey]{10}`
 * into the array of event-stream definitions the signal event loop runs.
 *
 * Grammar (identical to upstream): a comma-separated merge of selectors; each is
 * either `[a, b] > stream` ("between") or a stream
 * `[source|@markname|marktype:]type[!][filter]...[{throttle[,debounce]}]`.
 * Errors are thrown as strings upstream; here they are `Error`s with the same
 * messages.
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
  /** Nested stream (a between selector wrapped around a stream that has its own between). */
  stream?: StreamDef
  merge?: StreamDef[]
}

const VIEW = 'view'
const LBRACK = '['
const RBRACK = ']'
const LBRACE = '{'
const RBRACE = '}'
const COLON = ':'
const COMMA = ','
const NAME = '@'
const GT = '>'
const ILLEGAL = /[[\]{}]/
const DEFAULT_MARKS: Record<string, 1> = {
  '*': 1, arc: 1, area: 1, group: 1, image: 1, line: 1, path: 1, rect: 1, rule: 1, shape: 1, symbol: 1, text: 1, trail: 1,
}

interface Ctx { source: string; marks: Record<string, unknown> }

function fail(message: string): never {
  throw new Error(message)
}

/** Parse an event selector string into event-stream definitions. */
export function parseEventSelectorString(selector: string, source?: string, marks?: Record<string, unknown>): StreamDef[] {
  const ctx: Ctx = { source: source || VIEW, marks: marks || DEFAULT_MARKS }
  return parseMerge(selector.trim()).map((s) => parseSelector(s, ctx))
}

function find(s: string, i: number, endChar: string, pushChar?: string, popChar?: string): number {
  const n = s.length
  let count = 0
  for (; i < n; ++i) {
    const c = s[i]!
    if (!count && c === endChar) return i
    else if (popChar && popChar.includes(c)) --count
    else if (pushChar && pushChar.includes(c)) ++count
  }
  return i
}

function parseMerge(s: string): string[] {
  const output: string[] = []
  const n = s.length
  let start = 0
  let i = 0
  while (i < n) {
    i = find(s, i, COMMA, LBRACK + LBRACE, RBRACK + RBRACE)
    output.push(s.substring(start, i).trim())
    start = ++i
  }
  if (output.length === 0) fail('Empty event selector: ' + s)
  return output
}

function parseSelector(s: string, ctx: Ctx): StreamDef {
  return s[0] === '[' ? parseBetween(s, ctx) : parseStream(s, ctx)
}

function parseBetween(s: string, ctx: Ctx): StreamDef {
  const n = s.length
  let i = 1
  i = find(s, i, RBRACK, LBRACK, RBRACK)
  if (i === n) fail('Empty between selector: ' + s)
  const parts = parseMerge(s.substring(1, i))
  if (parts.length !== 2) fail('Between selector must have two elements: ' + s)
  s = s.slice(i + 1).trim()
  if (s[0] !== GT) fail("Expected '>' after between selector: " + s)
  const b = parts.map((p) => parseSelector(p, ctx))
  const stream = parseSelector(s.slice(1).trim(), ctx)
  if (stream.between) return { between: b, stream }
  stream.between = b
  return stream
}

function parseStream(s: string, ctx: Ctx): StreamDef {
  const stream: StreamDef = { source: ctx.source }
  const source: string[] = []
  let throttle: number[] = [0, 0]
  let markname = 0
  let start = 0
  let n = s.length
  let i = 0
  let j: number
  let filter: string[] | undefined

  // extract throttle from end
  if (s[n - 1] === RBRACE) {
    i = s.lastIndexOf(LBRACE)
    if (i >= 0) {
      try {
        throttle = parseThrottle(s.substring(i + 1, n - 1))
      } catch {
        fail('Invalid throttle specification: ' + s)
      }
      s = s.slice(0, i).trim()
      n = s.length
    } else fail('Unmatched right brace: ' + s)
    i = 0
  }
  if (!n) fail(s)

  // set name flag based on first char
  if (s[0] === NAME) markname = ++i

  // extract first part of multi-part stream selector
  j = find(s, i, COLON)
  if (j < n) {
    source.push(s.substring(start, j).trim())
    start = i = ++j
  }

  // extract remaining part of stream selector
  i = find(s, i, LBRACK)
  if (i === n) {
    source.push(s.substring(start, n).trim())
  } else {
    source.push(s.substring(start, i).trim())
    filter = []
    start = ++i
    if (start === n) fail('Unmatched left bracket: ' + s)
  }

  // extract filters
  while (i < n) {
    i = find(s, i, RBRACK)
    if (i === n) fail('Unmatched left bracket: ' + s)
    filter!.push(s.substring(start, i).trim())
    if (i < n - 1 && s[++i] !== LBRACK) fail('Expected left bracket: ' + s)
    start = ++i
  }

  // marshall event stream specification
  n = source.length
  if (!n || ILLEGAL.test(source[n - 1]!)) fail('Invalid event selector: ' + s)

  if (n > 1) {
    stream.type = source[1]
    if (markname) {
      stream.markname = source[0]!.slice(1)
    } else if (Object.hasOwn(ctx.marks, source[0]!)) {
      stream.marktype = source[0]
    } else {
      stream.source = source[0]
    }
  } else {
    stream.type = source[0]
  }
  if (stream.type!.slice(-1) === '!') {
    stream.consume = true
    stream.type = stream.type!.slice(0, -1)
  }
  if (filter != null) stream.filter = filter
  if (throttle[0]) stream.throttle = throttle[0]
  if (throttle[1]) stream.debounce = throttle[1]
  return stream
}

function parseThrottle(s: string): number[] {
  const a = s.split(COMMA)
  if (!s.length || a.length > 2) fail(s)
  return a.map((_) => {
    const x = +_
    if (x !== x) fail(s)
    return x
  })
}
