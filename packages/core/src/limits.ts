/** Budgets for untrusted specs. All are optional; omitted limits are unlimited. */
export interface SpecLimits {
  /** Maximum rows across all inline `data[].values` arrays. */
  maxRows?: number
  /** Maximum number of mark definitions, recursively (including nested groups). */
  maxMarks?: number
  /** Maximum length of any single string in the spec or generated scene. */
  maxStringLength?: number
  /** Maximum number of scene items in the rendered scene. */
  maxItems?: number
  /** Maximum length of any generated SVG path `d` attribute. */
  maxPathLength?: number
  /** Maximum serialized SVG length (checked by renderSpec after serialization). */
  maxSvgLength?: number
  /** Maximum object nesting depth in the spec. */
  maxDepth?: number
}

/** Typed limit violation (R12.1); hosts can distinguish it from a render bug. */
export class AsterLimitError extends Error {
  readonly code = 'ASTER_LIMIT'
  constructor(message: string) {
    super(`[aster] limit exceeded: ${message}`)
    this.name = 'AsterLimitError'
  }
}

function over(name: keyof SpecLimits, value: number, limit: number): never {
  throw new AsterLimitError(`${name} ${value} > ${limit}`)
}

/** Pre-flight checks, run before compilation/evaluation allocates the scene. */
export function checkSpecLimits(spec: Record<string, unknown>, limits: SpecLimits): void {
  let rows = 0
  let marks = 0
  let strings = 0
  let depth = 0
  const maxString = limits.maxStringLength
  const maxDepth = limits.maxDepth
  const walk = (v: unknown, d: number): void => {
    if (maxDepth != null && d > maxDepth) over('maxDepth', d, maxDepth)
    if (d > depth) depth = d
    if (typeof v === 'string') {
      strings++
      if (maxString != null && v.length > maxString) over('maxStringLength', v.length, maxString)
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, d + 1)
      return
    }
    if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, d + 1)
    }
  }
  walk(spec, 0)
  const data = (spec as { data?: unknown }).data
  const lists = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  for (const d of lists) {
    const values = (d as { values?: unknown }).values
    if (Array.isArray(values)) rows += values.length
  }
  if (limits.maxRows != null && rows > limits.maxRows) over('maxRows', rows, limits.maxRows)
  const countMarks = (m: unknown): void => {
    if (!Array.isArray(m)) return
    for (const mark of m) {
      marks++
      if (limits.maxMarks != null && marks > limits.maxMarks) over('maxMarks', marks, limits.maxMarks)
      countMarks((mark as { marks?: unknown }).marks)
    }
  }
  countMarks((spec as { marks?: unknown }).marks)
}

/** Post-evaluation checks for generated geometry, before SVG serialization. */
export function checkSceneLimits(scene: { items?: unknown[] }, limits: SpecLimits): void {
  let items = 0
  const maxPath = limits.maxPathLength
  const maxString = limits.maxStringLength
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    const children = n.items
    if (Array.isArray(children) && children.length) {
      for (const c of children) walk(c)
      return
    }
    items++
    if (limits.maxItems != null && items > limits.maxItems) over('maxItems', items, limits.maxItems)
    if (typeof n.path === 'string' && maxPath != null && n.path.length > maxPath) over('maxPathLength', n.path.length, maxPath)
    if (typeof n.text === 'string' && maxString != null && n.text.length > maxString) over('maxStringLength', n.text.length, maxString)
  }
  for (const it of scene.items ?? []) walk(it)
}

/** Final serialized-size check. */
export function checkSvgLength(svg: string, limits: SpecLimits): void {
  if (limits.maxSvgLength != null && svg.length > limits.maxSvgLength) over('maxSvgLength', svg.length, limits.maxSvgLength)
}
