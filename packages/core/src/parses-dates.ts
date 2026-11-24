/** Whether a dataset's `parse` may read a column with a date pattern (anything but `'auto'` or a table of plain types). */
export function parsesDates(parse: unknown): boolean {
  if (parse == null || parse === 'auto') return false
  if (typeof parse !== 'object' || Array.isArray(parse)) return true
  return Object.values(parse).some((t) => typeof t !== 'string' || /^\s*(date|utc)\s*:/i.test(t))
}
