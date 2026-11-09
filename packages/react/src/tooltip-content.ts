// What the default tooltip shows. It ships with the `interaction` capability (only a chart with hit testing shows
// tooltips), so `<SvgChart>` without it carries none of this.

/** The content vega-tooltip shows for a `tooltip` value: a `title` and `key: value` rows for an object, else one line. */
type TooltipContent = { title?: string; rows: Array<[string, string]> } | { text: string }

/** vega-tooltip's JSON for a nested value: objects deeper than `maxDepth` (2) read `[Object]`, cycles `[Circular]`. */
function stringifyTooltip(value: unknown, maxDepth = 2): string {
  const stack: unknown[] = []
  return JSON.stringify(value, function (this: unknown, _key: string, v: unknown) {
    if (typeof v !== 'object' || v === null) return v
    stack.length = stack.indexOf(this) + 1
    if (stack.length > maxDepth) return '[Object]'
    if (stack.includes(v)) return '[Circular]'
    stack.push(v)
    return v
  }) ?? String(value)
}

/**
 * What vega with vega-tooltip shows for an item's `tooltip` value (`formatValue`): nothing for null, undefined and `''`;
 * an array as `[a, b]`; an object as its `title` above a row per defined key (nested objects as JSON); anything else as
 * text. vega-tooltip's `image` key is not shown (an image URL from the data would bypass the chart's `urlPolicy`), so an
 * object with only an image shows nothing.
 */
export function tooltipContent(value: unknown): TooltipContent | null {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return { text: `[${value.map((v) => (typeof v === 'string' ? v : stringifyTooltip(v))).join(', ')}]` }
  if (typeof value === 'object') {
    const { title, image, ...rest } = value as Record<string, unknown>
    const rows: Array<[string, string]> = []
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined) continue
      rows.push([k, v !== null && typeof v === 'object' ? stringifyTooltip(v) : String(v)])
    }
    if (!title && rows.length === 0) return image ? null : { text: '{}' }
    return { ...(title ? { title: String(title) } : {}), rows }
  }
  return { text: String(value) }
}
