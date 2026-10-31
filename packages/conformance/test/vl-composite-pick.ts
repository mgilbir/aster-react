/** What the composite-mark tests compare of a compiled spec: the marks, axes, scales (without their domains), legends and signals, with the names the compilers are free to differ in made equal. */
export const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

/** The same name on both sides: Aster's name for a field with a path or a space in it carries a hash and has no `.` (names.ts `safeKey`). */
const HASH = /_[0-9a-f]{6}(?![0-9A-Za-z])/g
const sameName = (s: string, side: 'oracle' | 'aster'): string => (side === 'aster' ? s.replace(HASH, '') : s).replace(/\\\./g, '_').replace(/(?<=\w)\.(?=\w)/g, '_').replace(/\bdata\("([^"\\]*)"\)/g, "data('$1')")
const canon = (v: unknown, side: 'oracle' | 'aster'): unknown => {
  if (Array.isArray(v)) return v.map((x) => canon(x, side))
  if (typeof v === 'string') return sameName(v, side)
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  return Object.fromEntries(Object.keys(o).sort().filter((k) => !(k === 'data' && Array.isArray(o[k]))).map((k) => [k, k === 'from' ? '<from>' : canon(o[k], side)]))
}
export const pickSpec = (s: any, side: 'oracle' | 'aster'): unknown => canon(plain({
  marks: s.marks,
  // (Aster names `formatType: "time"` on the axis of a time unit, which vega infers from a time scale)
  axes: (s.axes ?? []).map(({ formatType, ...axis }: any) => (formatType === 'time' ? axis : { ...axis, formatType })),
  scales: (s.scales ?? []).map(({ domain: _d, ...rest }: any) => rest),
  legends: s.legends,
  signals: s.signals,
}), side)




