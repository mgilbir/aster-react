export interface Summary {
  median: number
  p95: number
  min: number
  max: number
  n: number
}

export function summarize(samples: number[]): Summary {
  const s = [...samples].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] ?? 0
  return { median: at(0.5), p95: at(0.95), min: at(0), max: at(1), n: s.length }
}

export function fmt(x: number, digits = 1): string {
  return x.toFixed(digits)
}

export function row(values: string[], widths: number[]): string {
  return values.map((v, i) => v.padStart(widths[i] ?? v.length)).join(' | ')
}

export function table(title: string, header: string[], rows: string[][]): string {
  const widths = header.map((hh, i) =>
    Math.max(hh.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const lines = [title, row(header.map((hh) => hh.toUpperCase()), widths), '-'.repeat(widths.reduce((a, b) => a + b + 3, 0))]
  for (const r of rows) lines.push(row(r, widths))
  return lines.join('\n')
}

/**
 * Per-pair ratio num[i] / den[i], summarized. Use it when the two series were measured back to back
 * in the same loop iteration: machine load, GC and frequency changes then hit both members of a pair
 * about equally and cancel in the ratio, which a ratio of two independently taken medians does not give.
 */
export function pairedRatio(num: number[], den: number[]): Summary {
  const n = Math.min(num.length, den.length)
  const ratios: number[] = []
  for (let i = 0; i < n; i++) ratios.push((num[i] as number) / Math.max(den[i] as number, 1e-9))
  return summarize(ratios)
}
