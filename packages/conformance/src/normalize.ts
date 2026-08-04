/**
 * SVG canonicalization for conformance diffing. Extracts geometric primitives
 * from an SVG string (vega's or ours), applies ancestor translate transforms so
 * coordinates are absolute, rounds to a fixed precision, and returns a sorted
 * list of canonical records. Equal geometry yields equal canonical output.
 */
import { parseSvg, type XmlEl } from './svg-parse.js'

const PRECISION = 3

export interface CanonicalResult {
  records: string[]
  root: string | null
}

export function canonicalizeSvg(svg: string): CanonicalResult {
  const root = parseSvg(svg)
  const records: string[] = []
  let rootRecord: string | null = null
  const walk = (el: XmlEl, tx: number, ty: number) => {
    const t = parseTransform(el.attrs['transform'])
    const x = tx + t.x
    const y = ty + t.y
    if (el.tag === 'svg') {
      rootRecord = `svg|${num(el.attrs['width']!)}|${num(el.attrs['height']!)}`
    } else if (el.tag === 'rect') {
      records.push(
        `rect|${x + numAttr(el.attrs['x'])}|${y + numAttr(el.attrs['y'])}|${numAttr(el.attrs['width'])}|${numAttr(el.attrs['height'])}|${styleOf(el)}`,
      )
    } else if (el.tag === 'line') {
      let x1 = x + numAttr(el.attrs['x1']), y1 = y + numAttr(el.attrs['y1'])
      let x2 = x + numAttr(el.attrs['x2']), y2 = y + numAttr(el.attrs['y2'])
      if (x1 > x2 || (x1 === x2 && y1 > y2)) { const tx = x1; x1 = x2; x2 = tx; const ty = y1; y1 = y2; y2 = ty }
      records.push(`line|${num(x1)}|${num(y1)}|${num(x2)}|${num(y2)}|${styleOf(el)}`)
    } else if (el.tag === 'circle') {
      records.push(
        `circle|${x + numAttr(el.attrs['cx'])}|${y + numAttr(el.attrs['cy'])}|${numAttr(el.attrs['r'])}|${styleOf(el)}`,
      )
    } else if (el.tag === 'path') {
      const dTrans = translatePath(el.attrs['d'] ?? '', x, y)
      if (dTrans && !isDegeneratePath(el.attrs['d'] ?? '')) {
        records.push(`path|${dTrans}|${styleOf(el)}`)
      }
    } else if (el.tag === 'text') {
      const text = textOf(el)
      records.push(
        `text|${x + numAttr(el.attrs['x'])}|${y + numAttr(el.attrs['y'])}|${text}|${styleOf(el)}`,
      )
    } else if (el.tag === 'polygon') {
      const pts = (el.attrs['points'] ?? '')
        .trim()
        .split(/\s+/)
        .map((p) => p.split(',').map((v) => x + parseFloat(v) || 0))
        .map(([px, py]) => `${num(px!)},${num(py!)}`)
      records.push(`polygon|${pts.join(' ')}|${styleOf(el)}`)
    }
    for (const c of el.children) {
      if (typeof c !== 'string') walk(c, x, y)
    }
  }
  walk(root, 0, 0)
  records.sort()
  return { records, root: rootRecord }
}

export function diffCanonical(a: CanonicalResult, b: CanonicalResult): string[] {
  const diffs: string[] = []
  if (a.root !== b.root) diffs.push(`root: ${a.root} vs ${b.root}`)
  const max = Math.max(a.records.length, b.records.length)
  for (let i = 0; i < max; i++) {
    const ra = a.records[i]
    const rb = b.records[i]
    if (ra !== rb) {
      diffs.push(`record[${i}]: ${ra ?? '<none>'}  |  ${rb ?? '<none>'}`)
      if (max > 40) break // avoid dumping huge diffs
    }
  }
  if (diffs.length === 0 && a.records.length === b.records.length) return diffs
  if (diffs.length === 0) diffs.push(`record count mismatch: ${a.records.length} vs ${b.records.length}`)
  return diffs
}

function styleOf(el: XmlEl): string {
  const keys = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity']
  const parts: string[] = []
  for (const k of keys) {
    const v = el.attrs[k]
    if (v === undefined) continue
    if (k === 'opacity' && roundIn(v) === '1') continue // no-op default
    parts.push(`${k}=${roundIn(v)}`)
  }
  return parts.join(';')
}

function roundIn(s: string): string {
  return s.replace(/-?\d+\.?\d*/g, (m) => num(parseFloat(m)))
}

function numAttr(v: string | undefined): number {
  return v === undefined ? 0 : parseFloat(v) || 0
}

function num(v: number | string): string {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n)) return String(n)
  const r = Math.round(n * 10 ** PRECISION) / 10 ** PRECISION
  const s = String(r)
  return s.endsWith('.000') ? s.slice(0, -4) : s.replace(/\.?0+$/, '')
}

/** Apply a translate offset and rounding to an SVG path `d` (absolute commands). */
function translatePath(d: string, tx: number, ty: number): string {
  if (!d) return ''
  let out = ''
  let i = 0
  let cmd = ''
  let paramIdx = 0
  const n = d.length
  while (i < n) {
    const ch = d[i]!
    if (/^[A-Za-z]$/.test(ch)) {
      cmd = ch
      paramIdx = 0
      out += ch
      i++
      continue
    }
    if (/\s|,/.test(ch)) {
      i++
      continue
    }
    const m = /[-+]?(?:\d+\.?\d*|\.d+)(?:[eE][-+]?\d+)?/.exec(d.slice(i))
    if (!m) {
      i++
      continue
    }
    const val = parseFloat(m[2]!)
    i += m[0].length
    let offset = 0
    if (cmd === 'H' || cmd === 'h') offset = tx
    else if (cmd === 'V' || cmd === 'v') offset = ty
    else offset = paramIdx % 2 === 0 ? tx : ty
    paramIdx++
    out += num(val + offset)
  }
  return out
}

/** Skip paths that have no real geometry (zero-area placeholders like `M0,0h0v0h0Z`). */
function isDegeneratePath(d: string): boolean {
  const nonCmd = d.replace(/[A-Za-z]/g, '')
  const nums = nonCmd.match(/-?\d+\.?\d*/g) || []
  if (nums.length === 0) return true
  return nums.every((n) => parseFloat(n) === 0)
}

function textOf(el: XmlEl): string {
  let s = ''
  for (const c of el.children) {
    if (typeof c === 'string') s += c
  }
  return s.trim()
}

function parseTransform(t: string | undefined): { x: number; y: number } {
  if (!t) return { x: 0, y: 0 }
  const m = /translate\(([-\d.]+)(?:,|\s+)([-\d.]+)\)/.exec(t)
  return m ? { x: parseFloat(m[1]!), y: parseFloat(m[2]!) } : { x: 0, y: 0 }
}
