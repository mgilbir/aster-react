/**
 * Delimiter-separated text (csv, tsv, any single-character delimiter): reading it into rows or row objects, and writing
 * rows back.
 *
 * The reader follows the dialect that d3-dsv and so Vega's data loading accept, quirks included where they decide what
 * a given text means:
 *   - one line break at the end of the text ends the last row (`\n`, `\r\n` or `\r`); a text that is just a line break
 *     is one row holding one empty field; the empty text has no rows;
 *   - a field that starts with `"` runs to the next `"` that is not doubled, and its text has `""` read as `"`; the
 *     character right after the closing quote is taken as the field's terminator whatever it is (a stray character
 *     there is swallowed), and a quote that is never closed runs to the end of the text, including the first character of
 *     the line break that ended it;
 *   - `parse` takes the first row as the column names, reads every value as text, and leaves a cell that is empty or
 *     missing as `''`; columns named twice keep the last cell; the row array gets a `columns` property.
 * Only the first character of the delimiter separates fields when reading.
 */

const QUOTE = 34
const NEWLINE = 10
const RETURN = 13

type Rows = string[][]

/** What ended a field. */
const enum End { Delimiter, LineBreak, Text }

/** The rows of `text`, each a list of its fields' text. */
function splitRows(text: string, delimiter: number): Rows {
  const rows: Rows = []
  if (text.length <= 0) return rows
  let end = text.length
  if (text.charCodeAt(end - 1) === NEWLINE) end--
  if (text.charCodeAt(end - 1) === RETURN) end--

  let pos = 0
  let ended: End
  /** Read the field at `pos`, moving `pos` past it and its terminator. */
  const readField = (): string => {
    const start = pos
    if (text.charCodeAt(start) === QUOTE) {
      let scan = start + 1
      let close: number
      // the closing quote is the first one not followed by another
      for (;;) {
        close = text.indexOf('"', scan)
        if (close < 0 || close >= end) {
          // never closed: the field runs to the end of the text, taking one more character if the line break that was
          // trimmed off the end is there
          ended = End.Text
          pos = end
          return text.slice(start + 1, end + 1).replace(/""/g, '"')
        }
        if (text.charCodeAt(close + 1) !== QUOTE) break
        scan = close + 2
      }
      const field = text.slice(start + 1, close).replace(/""/g, '"')
      pos = close + 1
      if (pos >= end) ended = End.Text
      else {
        const c = text.charCodeAt(pos++)
        if (c === NEWLINE) ended = End.LineBreak
        else if (c === RETURN) {
          ended = End.LineBreak
          if (text.charCodeAt(pos) === NEWLINE) pos++
        } else ended = End.Delimiter
      }
      return field
    }
    for (let i = start; i < end; i++) {
      const c = text.charCodeAt(i)
      if (c === NEWLINE || c === RETURN) {
        ended = End.LineBreak
        pos = i + 1
        if (c === RETURN && text.charCodeAt(pos) === NEWLINE) pos++
        return text.slice(start, i)
      }
      if (c === delimiter) {
        ended = End.Delimiter
        pos = i + 1
        return text.slice(start, i)
      }
    }
    ended = End.Text
    pos = end
    return text.slice(start, end)
  }

  do {
    const row: string[] = []
    do row.push(readField())
    while (ended! === End.Delimiter)
    rows.push(row)
  } while (ended! === End.LineBreak)
  return rows
}

// -- writing ------------------------------------------------------------------------------------------------------------

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

const formatYear = (year: number): string => (year < 0 ? '-' + pad(-year, 6) : year > 9999 ? '+' + pad(year, 6) : pad(year, 4))

/** A date as ISO 8601 in UTC, as short as it can be without losing anything: date only, then hours:minutes, seconds, ms. */
function formatDate(date: Date): string {
  if (Number.isNaN(+date)) return 'Invalid Date'
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const seconds = date.getUTCSeconds()
  const milliseconds = date.getUTCMilliseconds()
  const day = formatYear(date.getUTCFullYear()) + '-' + pad(date.getUTCMonth() + 1, 2) + '-' + pad(date.getUTCDate(), 2)
  const time = pad(hours, 2) + ':' + pad(minutes, 2)
  if (milliseconds) return day + 'T' + time + ':' + pad(seconds, 2) + '.' + pad(milliseconds, 3) + 'Z'
  if (seconds) return day + 'T' + time + ':' + pad(seconds, 2) + 'Z'
  if (minutes || hours) return day + 'T' + time + 'Z'
  return day
}

/** The names of the columns of `rows`, in order of first appearance. */
function columnsOf(rows: ArrayLike<Record<string, unknown>>): string[] {
  const seen = new Set<string>()
  for (const row of rows as unknown as Array<Record<string, unknown>>) for (const column in row) seen.add(column)
  return [...seen]
}

export interface Dsv {
  parse(text: string, f?: (row: Record<string, string>, i: number, columns: string[]) => unknown): Record<string, string>[] & { columns?: string[] }
  parseRows(text: string, f?: (row: string[], i: number) => unknown): string[][]
  format(rows: ArrayLike<Record<string, unknown>>, columns?: readonly string[]): string
  formatBody(rows: ArrayLike<Record<string, unknown>>, columns?: readonly string[]): string
  formatRows(rows: readonly unknown[][]): string
  formatRow(row: readonly unknown[]): string
  formatValue(value: unknown): string
}

/** A dialect with the given delimiter (its first character, when reading). */
export function dsvFormat(delimiter: string): Dsv {
  const separator = delimiter.charCodeAt(0)
  // written values containing a quote, a line break or a delimiter character are quoted
  const needsQuotes = new RegExp('["\\n\\r' + delimiter.replace(/[\\\]^-]/g, '\\$&') + ']')

  function formatValue(value: unknown): string {
    if (value == null) return ''
    if (value instanceof Date) return formatDate(value)
    const text = String(value)
    return needsQuotes.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }
  const formatRow = (row: readonly unknown[]): string => row.map(formatValue).join(delimiter)
  const body = (rows: ArrayLike<Record<string, unknown>>, columns: readonly string[]): string[] =>
    Array.from(rows as ArrayLike<Record<string, unknown>>, (row) => columns.map((column) => formatValue(row[column])).join(delimiter))

  /** Run the rows through `f` (as many calls as rows, numbered from 0); a row `f` answers `null`/`undefined` for is dropped. */
  function mapRows<T>(rows: Rows, f: ((row: string[], i: number) => unknown) | undefined): T[] {
    if (!f) return rows as unknown as T[]
    const out: T[] = []
    for (let i = 0; i < rows.length; i++) {
      const mapped = f(rows[i]!, i)
      if (mapped != null) out.push(mapped as T)
    }
    return out
  }

  return {
    parseRows: (text, f) => mapRows<string[]>(splitRows(text, separator), f),
    parse(text, f) {
      const [names = [], ...cells] = splitRows(text, separator)
      const toObject = (row: string[]): Record<string, string> => {
        const object: Record<string, string> = {}
        names.forEach((name, k) => {
          object[name] = row[k] || ''
        })
        return object
      }
      const out = (f ? mapRows<Record<string, string>>(cells, (row, i) => f(toObject(row), i, names)) : cells.map(toObject)) as Record<string, string>[] & { columns?: string[] }
      out.columns = names
      return out
    },
    format: (rows, columns) => {
      const names = columns ?? columnsOf(rows)
      return [names.map(formatValue).join(delimiter), ...body(rows, names)].join('\n')
    },
    formatBody: (rows, columns) => body(rows, columns ?? columnsOf(rows)).join('\n'),
    formatRows: (rows) => rows.map(formatRow).join('\n'),
    formatRow,
    formatValue,
  }
}
