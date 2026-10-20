/**
 * Scene-level differential (R8.1–R8.3).
 *
 * The SVG canonicalizer proves what a viewer sees; this compares the resolved
 * scenes *before* serialization: scale domains/ranges/bandwidth per scope,
 * group paint order, and per-item geometry/paint/stroke/extent records. It is
 * intentionally structural on the parts that are allowed to differ across
 * renderers (guide wrapper groups) and strict on the parts that must not.
 */
import * as vega from 'vega'
import { loadSpecData } from '@aster/core/load'
import {
  compileChart,
  evaluateChart,
  type ScaleSnapshot,
  type SceneGroup,
  type SceneItem,
  type SceneNode,
  type SceneRoot,
} from '@aster/core'

export interface SceneDiffResult {
  diffs: string[]
  groups: number
  items: number
  scales: number
}

interface ScopeRecord {
  path: string
  kind: string
  scales: ScaleSnapshot[]
  items?: SceneItem[]
}

const NUM_KEYS = new Set([
  'x', 'y', 'x2', 'y2', 'width', 'height', 'size', 'radius', 'innerRadius', 'outerRadius',
  'startAngle', 'endAngle', 'angle', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth',
])

function keyOf(node: Record<string, unknown>): string {
  // Names are generated differently by hand-written Vega and by our compiler
  // (`marks` vs. undefined), but role + marktype + sibling order is stable.
  return `${String(node.role ?? '')}|${String(node.marktype ?? '')}`
}

function round(v: number): number | string {
  if (!Number.isFinite(v)) return String(v)
  return Math.round(v * 1e6) / 1e6
}

function normValue(v: unknown): unknown {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return round(v)
  if (Array.isArray(v)) return v.map(normValue)
  return v
}

function scaleSnapshots(map: Record<string, unknown> | Map<string, unknown> | undefined): ScaleSnapshot[] {
  if (!map) return []
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map)
  const out: ScaleSnapshot[] = []
  for (const [name, raw] of entries) {
    // Vega's scene context maps a scale name to its dataflow operator; the
    // resolved scale itself is on `.value`.
    const s = ((raw as { value?: unknown })?.value ?? raw) as {
      type?: string
      domain?: () => unknown[]
      range?: () => unknown[]
      bandwidth?: () => number
    }
    if (typeof s.domain !== 'function' || typeof s.range !== 'function') continue
    const bandwidth = typeof s.bandwidth === 'function' ? s.bandwidth() : undefined
    const domain = Array.from(s.domain()).map(normValue)
    let samples: [unknown, unknown] | undefined
    if (domain.length >= 2 && typeof s === 'function') {
      try {
        const a = (s as unknown as (v: unknown) => unknown)(domain[0])
        const b = (s as unknown as (v: unknown) => unknown)(domain[domain.length - 1])
        if (typeof a === 'string' && /^rgb/i.test(a) && typeof b === 'string' && /^rgb/i.test(b)) samples = [normValue(a), normValue(b)]
      } catch { /* non-interpolating */ }
    }
    out.push({
      name,
      type: s.type ?? 'unknown',
      domain,
      range: Array.from(s.range()).map(normValue),
      ...(bandwidth != null ? { bandwidth: Number(round(bandwidth)) } : {}),
      ...(samples ? { samples } : {}),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function realRootItems(root: SceneNode): SceneNode[] {
  const out: SceneNode[] = []
  const visit = (node: SceneNode): void => {
    const n = node as SceneGroup
    if (!n.marktype && !n.role && !n.name && Array.isArray(n.items)) {
      for (const c of n.items) visit(c)
      return
    }
    if ((n.role === 'frame' || n.name === 'root') && Array.isArray(n.items)) {
      for (const c of n.items) visit(c)
      return
    }
    out.push(node)
  }
  visit(root)
  return out
}

function collectRealScopes(
  nodes: SceneNode[],
  parent = '',
  inherited: ScaleSnapshot[] = [],
  out: ScopeRecord[] = [],
): ScopeRecord[] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const n = node as SceneGroup
    const items = Array.isArray(n.items) ? n.items : undefined
    if (!items) continue
    const ctx = (n as unknown as { context?: { scales?: Record<string, unknown> } }).context
    // Vega puts a scope's context on the transparent group wrapping its
    // children, not on the named group node itself. Prefer the node's own
    // context, then the first wrapper child's context.
    const childCtx = !ctx?.scales
      ? items.find((c) => {
          const cc = c as SceneGroup
          return !cc.marktype && !cc.role && !cc.name
        }) as unknown as { context?: { scales?: Record<string, unknown> } } | undefined
      : undefined
    const scaleCtx = ctx?.scales ? ctx : childCtx?.context?.scales ? childCtx.context : undefined
    const scales = scaleCtx?.scales ? scaleSnapshots(scaleCtx.scales) : inherited
    const transparent = !n.marktype && !n.role && !n.name
    if (transparent) {
      // Vega's scene wraps each scope in an unnamed group that carries the
      // context (and therefore the resolved scales). Keep it out of the path.
      collectRealScopes(items as SceneNode[], parent, scales, out)
      continue
    }
    const key = keyOf(n as unknown as Record<string, unknown>)
    const idx = counts.get(key) ?? 0
    counts.set(key, idx + 1)
    const path = `${parent}/${key}#${idx}`
    const isMarkGroup = n.marktype !== 'group' && n.marktype != null
    out.push({ path, kind: key, scales, ...(isMarkGroup ? { items: items as SceneItem[] } : {}) })
    const groups = items.filter((i) => {
      const c = i as SceneGroup
      return !!c.items && (c.marktype === 'group' || c.marktype == null)
    })
    collectRealScopes(groups as SceneNode[], path, scales, out)
  }
  return out
}

function collectOurScopes(
  nodes: SceneNode[],
  parent = '',
  out: ScopeRecord[] = [],
): ScopeRecord[] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const n = node as SceneGroup
    const items = Array.isArray(n.items) ? n.items : undefined
    if (!items) continue
    const key = keyOf(n as unknown as Record<string, unknown>)
    const idx = counts.get(key) ?? 0
    counts.set(key, idx + 1)
    const path = `${parent}/${key}#${idx}`
    const isMarkGroup = n.marktype !== 'group' && n.marktype != null
    const scales = n.__scales ? fromOurScales(n.__scales) : []
    // Top-level mark groups inherit the root snapshot for the scope check; a
    // nested group only advertises its own local scales.
    if (isMarkGroup || scales.length) {
      out.push({ path, kind: key, scales, ...(isMarkGroup ? { items: items as SceneItem[] } : {}) })
    }
    const groups = items.filter((i) => {
      const c = i as SceneGroup
      return !!c.items && (c.marktype === 'group' || c.marktype == null)
    })
    collectOurScopes(groups as SceneNode[], path, out)
  }
  return out
}

function fromOurScales(scales: ScaleSnapshot[]): ScaleSnapshot[] {
  return scales.map((s) => ({
    name: s.name,
    type: s.type,
    domain: s.domain.map(normValue),
    range: s.range.map(normValue),
    ...(s.bandwidth != null ? { bandwidth: Number(round(s.bandwidth)) } : {}),
    ...(s.samples ? { samples: [normValue(s.samples[0]), normValue(s.samples[1])] as [unknown, unknown] } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name))
}

function itemRecord(it: SceneItem, marktype: string): string {
  const rec = { ...(it as unknown as Record<string, unknown>) }
  // Text polar anchoring is a renderer step in vega (x/y stay at the centre and
  // radius/theta are kept on the item); our engine bakes it at build time.
  // Normalize both to the anchored position.
  if (marktype === 'text' && typeof rec.radius === 'number' && typeof rec.theta === 'number') {
    const t = (rec.theta as number) - Math.PI / 2
    rec.x = (rec.x as number ?? 0) + (rec.radius as number) * Math.cos(t)
    rec.y = (rec.y as number ?? 0) + (rec.radius as number) * Math.sin(t)
    delete rec.radius
    delete rec.theta
  }
  // Area marks: vega keeps the baseline on y2 (with a NaN height) when the
  // spatial adjust ran; our builder folds it into y. Normalize to the baseline.
  if (marktype === 'area' && rec.y == null && typeof rec.y2 === 'number' && !Number.isFinite(rec.height as number)) {
    rec.y = rec.y2
  }
  const parts: string[] = [String(rec.text ?? '')]
  for (const key of NUM_KEYS) {
    let v = rec[key]
    // A symbol's default size (and therefore radius) is implicit in the scene;
    // normalize it so a hand-written mark and a compiled mark agree.
    if (key === 'size' && v == null && marktype === 'symbol') v = 30
    if (typeof v === 'number' && Number.isFinite(v)) parts.push(`${key}=${round(v)}`)
  }
  for (const key of ['fill', 'stroke', 'strokeDash', 'strokeCap', 'strokeJoin', 'align', 'baseline', 'fontWeight', 'defined']) {
    const v = rec[key]
    if (v != null) parts.push(`${key}=${JSON.stringify(normValue(v))}`)
  }
  if (typeof rec.path === 'string' && marktype !== 'shape' && marktype !== 'geoshape' && marktype !== 'contour') {
    parts.push(`path=${rec.path.replace(/-?\d+\.?\d*(?:e[-+]?\d+)?/gi, (m) => String(round(Number(m))))}`)
  }
  return parts.join(';')
}

function compareScales(a: ScaleSnapshot[], b: ScaleSnapshot[], scope: string, diffs: string[]): number {
  const am = new Map(a.map((s) => [s.name, s]))
  const bm = new Map(b.map((s) => [s.name, s]))
  const names = [...new Set([...am.keys(), ...bm.keys()])].sort()
  for (const name of names) {
    const x = am.get(name)
    const y = bm.get(name)
    if (!x || !y) {
      diffs.push(`${scope} scale ${name}: ${x ? 'missing in ours' : 'missing in oracle'}`)
      continue
    }
    const interpolating = x.samples != null || y.samples != null
    // d3 calls the same colour interpolator a different concrete type
    // (`sequential-linear` vs our `linear`/`sequential`); the sampled endpoints
    // are the meaningful comparison.
    if (!interpolating && x.type !== y.type) diffs.push(`${scope} scale ${name}: type ${x.type} vs ${y.type}`)
    const emptyDomain = (d: unknown[]): boolean => d.length === 0 || d.every((v) => v === 'NaN' || (typeof v === 'number' && Number.isNaN(v)))
    if (!(emptyDomain(x.domain) && emptyDomain(y.domain)) && JSON.stringify(x.domain) !== JSON.stringify(y.domain)) {
      diffs.push(`${scope} scale ${name}: domain ${JSON.stringify(x.domain)} vs ${JSON.stringify(y.domain)}`)
    }
    if (interpolating) {
      if (JSON.stringify(x.samples) !== JSON.stringify(y.samples)) diffs.push(`${scope} scale ${name}: colour endpoints ${JSON.stringify(x.samples)} vs ${JSON.stringify(y.samples)}`)
    } else if (JSON.stringify(x.range) !== JSON.stringify(y.range)) {
      diffs.push(`${scope} scale ${name}: range ${JSON.stringify(x.range)} vs ${JSON.stringify(y.range)}`)
    }
    if (x.bandwidth !== y.bandwidth) diffs.push(`${scope} scale ${name}: bandwidth ${x.bandwidth} vs ${y.bandwidth}`)
  }
  return names.length
}

function itemBounds(it: SceneItem): { x1: number; y1: number; x2: number; y2: number } | null {
  const rec = it as unknown as Record<string, unknown>
  const x = rec.x
  const y = rec.y
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
  let w: number | undefined
  let h: number | undefined
  const x2 = rec.x2
  const y2 = rec.y2
  if (typeof rec.width === 'number') w = rec.width
  else if (typeof x2 === 'number') w = x2 - x
  if (typeof rec.height === 'number') h = rec.height
  else if (typeof y2 === 'number') h = y2 - y
  if (typeof rec.radius === 'number') { w = rec.radius * 2; h = rec.radius * 2; return { x1: x - rec.radius, y1: y - rec.radius, x2: x + rec.radius, y2: y + rec.radius } }
  if (w == null && typeof rec.size === 'number') { const r = Math.sqrt(rec.size) / 2; w = r * 2; h = r * 2; return { x1: x - r, y1: y - r, x2: x + r, y2: y + r } }
  if (w == null && rec.text != null) { const r = ((rec.fontSize as number | undefined) ?? 11) * String(rec.text).length * 0.3; w = r * 2; h = r }
  if (w == null || h == null) return null
  return { x1: Math.min(x, x + w), y1: Math.min(y, y + h), x2: Math.max(x, x + w), y2: Math.max(y, y + h) }
}

function overlaps(a: { x1: number; y1: number; x2: number; y2: number }, b: typeof a): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1
}

/**
 * Item equality is a multiset check; paint order is separately checked for
 * items whose painted extents actually overlap (the only place order changes
 * what a viewer sees).
 */
function compareItems(real: SceneItem[], ours: SceneItem[], path: string, diffs: string[], marktype: string): void {
  const realRecords = real.map((it) => itemRecord(it, marktype))
  const ourRecords = ours.map((it) => itemRecord(it, marktype))
  const rs = [...realRecords].sort()
  const os = [...ourRecords].sort()
  if (rs.length !== os.length) diffs.push(`${path}: item count ${rs.length} vs ${os.length}`)
  const n = Math.max(rs.length, os.length)
  let reported = 0
  for (let i = 0; i < n; i++) {
    if (rs[i] !== os[i]) {
      if (reported++ < 6) diffs.push(`${path} item: ${rs[i] ?? '<none>'}  |  ${os[i] ?? '<none>'}`)
    }
  }
  if (rs.length !== os.length) return
  // Paint order only matters where bounding boxes overlap. Match records to
  // their occurrence indices in both arrays, then compare relative order.
  const firstReal = new Map<string, number>()
  const firstOur = new Map<string, number>()
  realRecords.forEach((r, i) => { if (!firstReal.has(r)) firstReal.set(r, i) })
  ourRecords.forEach((r, i) => { if (!firstOur.has(r)) firstOur.set(r, i) })
  for (let i = 0; i < real.length; i++) {
    const bi = itemBounds(real[i]!)
    if (!bi) continue
    for (let j = i + 1; j < real.length; j++) {
      const bj = itemBounds(real[j]!)
      if (!bj || !overlaps(bi, bj)) continue
      const ri = firstReal.get(realRecords[i]!)
      const rj = firstReal.get(realRecords[j]!)
      const oi = firstOur.get(realRecords[i]!)
      const oj = firstOur.get(realRecords[j]!)
      if (ri == null || rj == null || oi == null || oj == null) continue
      if ((ri - rj) * (oi - oj) < 0) {
        diffs.push(`${path}: paint order differs for overlapping items (${realRecords[i]!.slice(0, 60)} / ${realRecords[j]!.slice(0, 60)})`)
        return
      }
    }
  }
}

/** Compare one spec (already Vega) through real Vega and the engine. */
export async function sceneDiff(spec: Record<string, unknown>): Promise<SceneDiffResult> {
  // URL datasets are part of the resolved scene; resolve them exactly as the
  // renderer would before comparing.
  spec = await loadSpecData(spec as never) as unknown as Record<string, unknown>
  const runtime = vega.parse(spec as never)
  const view = new (vega as any).View(runtime, { renderer: 'none' })
  const diffs: string[] = []
  let groups = 0
  let items = 0
  let scales = 0
  try {
    await view.runAsync()
    const realRoot = view.scenegraph().root as SceneNode
    const realNodes = realRootItems(realRoot)
    const realScopes = collectRealScopes(realNodes)
    const scene = evaluateChart(compileChart(spec as never))
    const ourScopes = collectOurScopes(scene.items)
    // Root scope scales come from the view's own runtime context (the scene's
    // context scales are operator wrappers; `_runtime.scales` is the root map).
    const rootScales = scaleSnapshots((view as unknown as { _runtime?: { scales?: Map<string, unknown> } })._runtime?.scales)
    scales += compareScales(rootScales, fromOurScales(scene.__scales ?? []), 'root', diffs)

    const realByPath = new Map(realScopes.map((s) => [s.path, s]))
    for (const ours of ourScopes) {
      const real = realByPath.get(ours.path)
      if (!real) {
        diffs.push(`${ours.path}: scope missing in oracle scene`)
        continue
      }
      groups++
      // Nested scopes compare their local scales; top-level mark groups are
      // covered by the root snapshot above.
      if (ours.scales.length) {
        const only = new Set(ours.scales.map((s) => s.name))
        scales += compareScales(real.scales.filter((s) => only.has(s.name)), ours.scales, ours.path, diffs)
      }
      if (ours.items) {
        items += ours.items.length
        if (!real.items) {
          diffs.push(`${ours.path}: items missing in oracle scene`)
          continue
        }
        compareItems(real.items, ours.items, ours.path, diffs, ours.kind.split('|')[1] ?? '')
      }
    }
  } finally {
    view.finalize()
  }
  return { diffs, groups, items, scales }
}
