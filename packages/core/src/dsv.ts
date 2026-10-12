/**
 * Delimited-text parsing — a faithful port of d3-dsv (3.0.1), pinned by
 * oracle vectors (`testdata/vectors/d3-dsv.json`).
 *
 * One deviation, deliberate and noted in the ADR: upstream builds row objects
 * with `new Function` (a codegen perf trick). That is unsafe to compile at
 * runtime, so the row converter here is a plain loop with the identical
 * contract — `d[i] || ""`, meaning a CSV cell containing `0` or `false` reads
 * back as the empty string, exactly as upstream.
 */

const EOL = {}
const EOF = {}
const QUOTE = 34
const NEWLINE = 10
const RETURN = 13

// Compute unique columns in order of discovery.
function inferColumns(rows: ArrayLike<Record<string, unknown>>): string[] {
  const columnSet = Object.create(null) as Record<string, string>
  const columns: string[] = []
  for (const row of rows as unknown[]) {
    for (const column in row as Record<string, unknown>) {
      if (!(column in columnSet)) {
        columns.push(columnSet[column] = column)
      }
    }
  }
  return columns
}

function pad(value: number, width: number): string {
  const s = value + ''
  const length = s.length
  return length < width ? new Array(width - length + 1).join('0') + s : s
}

function formatYear(year: number): string {
  return year < 0 ? '-' + pad(-year, 6)
    : year > 9999 ? '+' + pad(year, 6)
    : pad(year, 4)
}

function formatDate(date: Date): string {
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const seconds = date.getUTCSeconds()
  const milliseconds = date.getUTCMilliseconds()
  return isNaN(+date) ? 'Invalid Date'
    : formatYear(date.getUTCFullYear()) + '-' + pad(date.getUTCMonth() + 1, 2) + '-' + pad(date.getUTCDate(), 2)
    + (milliseconds ? 'T' + pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(seconds, 2) + '.' + pad(milliseconds, 3) + 'Z'
    : seconds ? 'T' + pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(seconds, 2) + 'Z'
    : minutes || hours ? 'T' + pad(hours, 2) + ':' + pad(minutes, 2) + 'Z'
    : '')
}

export interface Dsv {
  parse(text: string, f?: (row: Record<string, string>, i: number, columns: string[]) => unknown): Record<string, string>[] & { columns?: string[] }
  parseRows(text: string, f?: (row: string[], i: number) => unknown): string[][]
  format(rows: ArrayLike<Record<string, unknown>>, columns?: readonly string[]): string
  formatBody(rows: ArrayLike<Record<string, unknown>>, columns?: readonly string[]): string
  formatRows(rows: readonly unknown[][]): string
  formatRow(row: readonly unknown[]): string
  formatValue(value: unknown): unknown
}

export function dsvFormat(delimiter: string): Dsv {
  const reFormat = new RegExp('["' + delimiter + '\n\r]')
  function parse(text: string, f?: (row: Record<string, string>, i: number, columns: string[]) => unknown): Record<string, string>[] & { columns?: string[] } {
    let convert: ((row: string[], i: number) => unknown) | undefined
    let columns: string[] | undefined
    const rows = parseRows(text, function (this: unknown, row: string[], i: number) {
      if (convert) return convert(row, i - 1)
      // Upstream compiles this with new Function; the loop is the CSP-safe
      // equivalent with the same `d[i] || ""` contract.
      columns = row
      const template = row.map((name) => [name, ''] as const)
      const object = (d: string[]) => {
        const o: Record<string, string> = {}
        template.forEach(([name], idx) => { o[name] = d[idx] || '' })
        return o
      }
      const f3 = f as ((row: Record<string, string>, i: number, columns: string[]) => unknown) | undefined
      convert = f3
        ? (r: string[], i: number) => f3(object(r), i, row)
        : (r: string[], i: number) => object(r)
      // Implicit undefined, as upstream: the header row is dropped.
      return undefined
    })
    const out = rows as unknown as Record<string, string>[] & { columns?: string[] }
    out.columns = columns || []
    return out
  }

  function parseRows(text: string, f?: (row: string[], i: number) => unknown): string[][] {
    const rows: string[][] = [] // output rows
    let N = text.length
    let I = 0 // current character index
    let n = 0 // current line number
    let t: unknown // current token
    let eof = N <= 0 // current token followed by EOF?
    let eol = false // current token followed by EOL?
    // Strip the trailing newline.
    if (text.charCodeAt(N - 1) === NEWLINE) --N
    if (text.charCodeAt(N - 1) === RETURN) --N

    function token(): unknown {
      if (eof) return EOF
      if (eol) return eol = false, EOL
      // Unescape quotes.
      let i: number
      let c: number
      const j = I
      if (text.charCodeAt(j) === QUOTE) {
        while (I++ < N && text.charCodeAt(I) !== QUOTE || text.charCodeAt(++I) === QUOTE) { /* scan */ }
        if ((i = I) >= N) eof = true
        else if ((c = text.charCodeAt(I++)) === NEWLINE) eol = true
        else if (c === RETURN) { eol = true; if (text.charCodeAt(I) === NEWLINE) ++I }
        return text.slice(j + 1, i - 1).replace(/""/g, '"')
      }
      // Find next delimiter or newline.
      while (I < N) {
        c = text.charCodeAt(i = I++)
        if (c === NEWLINE) eol = true
        else if (c === RETURN) { eol = true; if (text.charCodeAt(I) === NEWLINE) ++I }
        else if (c !== delimiter.charCodeAt(0)) continue
        return text.slice(j, i)
      }
      // Return last token before EOF.
      return eof = true, text.slice(j, N)
    }

    while ((t = token()) !== EOF) {
      let row: string[] = []
      while (t !== EOL && t !== EOF) row.push(t as string), t = token()
      if (f && (row = f(row, n++) as string[] ?? null as unknown as string[]) == null) continue
      rows.push(row)
    }
    return rows
  }

  function preformatBody(rows: ArrayLike<Record<string, unknown>>, columns: readonly string[]): string[] {
    const out: string[] = []
    for (const row of rows as unknown[]) {
      out.push(columns.map((column) => formatValue((row as Record<string, unknown>)[column])).join(delimiter))
    }
    return out
  }

  function formatValue(value: unknown): unknown {
    return value == null ? ''
      : value instanceof Date ? formatDate(value)
      : reFormat.test(value += '') ? '"' + (value as string).replace(/"/g, '""') + '"'
      : value
  }

  function formatRow(row: readonly unknown[]): string {
    return row.map(formatValue).join(delimiter)
  }

  return {
    parse,
    parseRows,
    format(rows, columns) {
      if (columns == null) columns = inferColumns(rows)
      return [columns.map(formatValue).join(delimiter)].concat(preformatBody(rows, columns)).join('\n')
    },
    formatBody(rows, columns) {
      if (columns == null) columns = inferColumns(rows)
      return preformatBody(rows, columns).join('\n')
    },
    formatRows(rows) {
      return rows.map(formatRow).join('\n')
    },
    formatRow,
    formatValue,
  }
}
