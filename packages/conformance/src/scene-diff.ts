/**
 * Scene-level differential.
 *
 * The SVG canonicalizer proves what a viewer sees; this compares the resolved scenes *before* serialization, as one tree on
 * each side:
 *   - the root scales, and every group item's own scales (by name, on both sides: a scale only one side has is a difference);
 *   - in every scope (the root group, each group item), the marks in PAINT order: vega's scenegraph keeps definition order and
 *     its renderers paint by `zindex` (stable: the items without one first, then by zindex), so the oracle's list is put in that
 *     order; Aster's scene is in paint order already. The marks are compared as a sequence of role|marktype (a mark one side
 *     has and the other lacks, or two marks of different types painted in the other order, is a difference);
 *   - each mark's items: a multiset of item records (every encode channel the pinned Vega schema declares, `encodeEntry`, that
 *     either side's item carries), and the paint order of items whose painted extents overlap (the only place it changes what a
 *     viewer sees), with item `zindex` applied on the oracle's side as its renderers apply it;
 *   - a group mark's items are compared one by one, each with its own scales and marks, recursively (facets, nested groups).
 * Axes, legends and titles (role axis / legend / title) are left out on both sides: their scenegraphs are built differently
 * (vega: group marks of parts; Aster: one node per guide), and their output is compared by the SVG gates and the guide
 * differentials.
 *
 * The result carries what was compared (`items`, `attributes`, `marks`, `groups`, `scales`) and how many items the oracle's
 * scene holds (`oracleItems`): the gate fails a spec whose oracle drew items of which none was compared.
 */
import * as vega from 'vega'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import {
  compileChart,
  evaluateChart,
  type ScaleSnapshot,
  type SceneGroup,
  type SceneItem,
  type SceneNode,
  type SceneRoot,
} from '@aster-charts/core'
import { forEngines } from './engines.js'

export interface SceneDiffResult {
  diffs: string[]
  /** group items compared (scopes) */
  groups: number
  /** items compared (group items included) */
  items: number
  /** channel values compared over those items */
  attributes: number
  /** marks compared */
  marks: number
  scales: number
  /** the items (group items included) of the oracle's scene, guides aside: what there was to compare */
  oracleItems: number
}

/** The encode channels of the pinned Vega schema (`encodeEntry`): what an item record holds, when either side's item has it. */
const CHANNELS: readonly string[] = (() => {
  const require = createRequire(import.meta.url)
  const schemaPath = require.resolve('vega').replace(/build[\\/][^\\/]+$/, 'build/vega-schema.json')
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { definitions: { encodeEntry: { properties: Record<string, unknown> } } }
  return Object.keys(schema.definitions.encodeEntry.properties).sort()
})()

/** A group item's channels Aster draws into its background path instead of keeping (see `itemRecord`). */
const GROUP_DRAWN = ['cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomLeft', 'cornerRadiusBottomRight', 'x2', 'y2', 'xc', 'yc']

/**
 * The path vega draws for a shape-drawn item (shape, geoshape, contour): its `shape` is a function of a context, which with no
 * context returns the path string (vega-scenegraph path/shapes.js `shape`). Aster keeps that string as `shape`.
 */
function vegaShape(it: SceneItem): Record<string, unknown> {
  const rec = it as unknown as { shape?: unknown; mark?: { shape?: unknown } }
  const gen = (rec.mark?.shape ?? rec.shape) as { context?: (c: null) => (item: unknown) => unknown } | undefined
  if (typeof gen?.context !== 'function') return {}
  const d = gen.context(null)(it)
  return typeof d === 'string' ? { shape: d } : {}
}

/**
 * What Aster keeps of a group item's own channels in another form: its aria channels in `itemAria` (the node's own `description`,
 * `aria`, `ariaRole*` are its MARK's, drawn on the mark's container), its `clip` as a `contentClip` node wrapping its content,
 * and its `strokeForeground` as a second `_bg` item after the content.
 */
function asterGroupItem(g: SceneGroup): Record<string, unknown> {
  const aria = (g as { itemAria?: Record<string, unknown> }).itemAria ?? {}
  const kids = g.items ?? []
  const clipped = kids.some((c) => flag(c, 'contentClip'))
  // (a stroke drawn in the foreground is a second `_bg` item after the content)
  const foreground = kids.length > 1 && flag(kids[kids.length - 1], '_bg')
  return { description: aria.description, aria: aria.aria, ariaRole: aria.ariaRole, ariaRoleDescription: aria.ariaRoleDescription, clip: clipped ? true : undefined, strokeForeground: foreground ? true : undefined }
}

/** Guides: compared by the SVG gates, not here (see the header). */
const GUIDE_ROLES: ReadonlySet<string> = new Set(['axis', 'legend', 'title'])

/** One side's scene as the comparison reads it. */
interface CMark { key: string; items: CItem[] }
interface CItem { item: SceneItem; record: string; fields: number; scales?: ScaleSnapshot[]; marks?: CMark[] }

function keyOf(node: Record<string, unknown>): string {
  // Names are generated differently by hand-written Vega and by our compiler
  // (`marks` vs. undefined), but role + marktype is stable.
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
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().filter((k) => typeof o[k] !== 'function').map((k) => [k, normValue(o[k])]))
  }
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

/**
 * The record of an item: every encode channel either side may carry, normalised. Returns the record and the channels it holds.
 * `own` replaces channels the side keeps in another form (see `vegaShape`, `asterGroupItem`).
 */
function itemRecord(it: SceneItem, marktype: string, own: Record<string, unknown> = {}): { record: string; fields: number } {
  const rec = { ...(it as unknown as Record<string, unknown>), ...own }
  // Area marks: vega keeps the baseline on y2 (with a NaN height) when the
  // spatial adjust ran; our builder folds it into y. Normalize to the baseline.
  if (marktype === 'area' && rec.y == null && typeof rec.y2 === 'number' && !Number.isFinite(rec.height as number)) {
    rec.y = rec.y2
  }
  // vega's renderers read a missing position as 0 (`item.x || 0`), and a group's, rect's or image's missing size as 0: Aster
  // writes the 0 out. A NaN is drawn as 0 too, but it is kept: it is a different value in every scene a host reads.
  for (const k of ['x', 'y']) if (rec[k] === undefined) rec[k] = 0
  if (marktype === 'group' || marktype === 'rect' || marktype === 'image') for (const k of ['width', 'height']) if (rec[k] === undefined) rec[k] = 0
  // A symbol's default size (and therefore radius) is implicit in the scene;
  // normalize it so a hand-written mark and a compiled mark agree.
  if (marktype === 'symbol' && rec.size == null) rec.size = 30
  // (a group item's corners and its x2 / y2: Aster keeps the background it draws -- the `_bg` path -- not the channels; the SVG
  // gates compare that path)
  if (marktype === 'group') for (const k of GROUP_DRAWN) delete rec[k]
  // (a shape-drawn item's path is its `shape`, compared as such: Aster keeps a copy of it as `path` too, vega none)
  if (marktype === 'shape' || marktype === 'geoshape' || marktype === 'contour') delete rec.path
  // (an item `clip` or `strokeForeground` of false is no clip, no foreground stroke)
  if (rec.clip === false) delete rec.clip
  if (rec.strokeForeground === false) delete rec.strokeForeground
  const parts: string[] = []
  for (const key of CHANNELS) {
    const v = rec[key]
    if (v === undefined || typeof v === 'function') continue
    if ((key === 'path' || key === 'shape') && typeof v === 'string') parts.push(`${key}=${v.replace(/-?\d+\.?\d*(?:e[-+]?\d+)?/gi, (m) => String(round(Number(m))))}`)
    else parts.push(`${key}=${JSON.stringify(normValue(v))}`)
  }
  return { record: parts.join(';'), fields: parts.length }
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
    // NaN is the bandwidth of a band scale over a non-numeric range, on both sides
    if (x.bandwidth !== y.bandwidth && !(Number.isNaN(x.bandwidth) && Number.isNaN(y.bandwidth))) diffs.push(`${scope} scale ${name}: bandwidth ${x.bandwidth} vs ${y.bandwidth}`)
  }
  return names.length
}

/**
 * vega-scenegraph's paint order of a mark's items, or of a scope's marks: those without a (truthy) `zindex` first, in order, then
 * the others by zindex, stable (scenegraph `zorder` + `visit`).
 */
function zorder<T>(nodes: readonly T[]): T[] {
  const z = (n: T): number => Number((n as { zindex?: unknown }).zindex) || 0
  if (!nodes.some((n) => z(n) !== 0)) return [...nodes]
  const plain = nodes.filter((n) => z(n) === 0)
  const indexed = nodes.map((n, i) => ({ n, i })).filter(({ n }) => z(n) !== 0).sort((a, b) => z(a.n) - z(b.n) || a.i - b.i).map(({ n }) => n)
  return [...plain, ...indexed]
}

/** The oracle's marks of a scope (a group item of vega's scenegraph: its `items` are its marks), in paint order. */
function vegaMarks(groupItem: SceneNode): CMark[] {
  const marks = ((groupItem as SceneGroup).items ?? []) as SceneGroup[]
  return zorder(marks.filter((m) => m.marktype != null && !GUIDE_ROLES.has(String(m.role)))).map((m) => {
    const items = zorder((m.items ?? []) as SceneItem[])
    const shaped = m.marktype === 'shape' || m.marktype === 'geoshape' || m.marktype === 'contour'
    if (m.marktype !== 'group') return { key: keyOf(m as unknown as Record<string, unknown>), items: items.map((it) => ({ item: it, ...itemRecord(it, String(m.marktype), shaped ? vegaShape(it) : {}) })) }
    return {
      key: keyOf(m as unknown as Record<string, unknown>),
      items: items.map((it) => {
        // (vega puts a scope's context, and so its own scales, on the group item)
        const ctx = (it as unknown as { context?: { scales?: Record<string, unknown> } }).context
        return { item: it, ...itemRecord(it, 'group'), scales: ctx?.scales ? scaleSnapshots(Object.fromEntries(Object.entries(ctx.scales))) : [], marks: vegaMarks(it as unknown as SceneNode) }
      }),
    }
  })
}

const flag = (n: unknown, k: string): boolean => (n as Record<string, unknown>)[k] === true

/**
 * Aster's marks of a scope, in its order (paint order). A leaf mark is a node holding its items; a group mark's items are
 * consecutive group nodes of one `markIndex`; a group item holds its background (`_bg`), its content (perhaps wrapped in a
 * `contentClip` node) and its foreground.
 */
function asterMarks(nodes: readonly SceneNode[]): CMark[] {
  const out: CMark[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as SceneGroup
    if (flag(n, '_bg')) continue
    if (flag(n, 'contentClip')) { for (const m of asterMarks((n.items ?? []) as SceneNode[])) out.push(m); continue }
    if (n.marktype === 'group' && !flag(n, '_scope') && !flag(n, 'emptyMark') && GUIDE_ROLES.has(String(n.role))) continue
    if (n.marktype === 'group') {
      const id = (n as { markIndex?: unknown }).markIndex
      const run: SceneGroup[] = [n]
      while (id !== undefined && i + 1 < nodes.length) {
        const next = nodes[i + 1] as SceneGroup
        if (next.marktype !== 'group' || (next as { markIndex?: unknown }).markIndex !== id || flag(next, '_bg')) break
        run.push(next)
        i++
      }
      out.push({
        key: keyOf(n as unknown as Record<string, unknown>),
        items: run.filter((g) => !flag(g, 'emptyMark')).map((g) => ({
          item: g as unknown as SceneItem, ...itemRecord(g as unknown as SceneItem, 'group', asterGroupItem(g)),
          scales: g.__scales ? fromOurScales(g.__scales) : [],
          marks: asterMarks((g.items ?? []) as SceneNode[]),
        })),
      })
      continue
    }
    if (n.marktype != null) {
      out.push({ key: keyOf(n as unknown as Record<string, unknown>), items: ((n.items ?? []) as SceneItem[]).map((it) => ({ item: it, ...itemRecord(it, String(n.marktype)) })) })
      continue
    }
    if (Array.isArray(n.items)) for (const m of asterMarks(n.items as SceneNode[])) out.push(m)
  }
  return out
}

function countItems(marks: readonly CMark[]): number {
  let n = 0
  for (const m of marks) for (const it of m.items) n += 1 + (it.marks ? countItems(it.marks) : 0)
  return n
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
  if (typeof rec.radius === 'number' && rec.text == null) { w = rec.radius * 2; h = rec.radius * 2; return { x1: x - rec.radius, y1: y - rec.radius, x2: x + rec.radius, y2: y + rec.radius } }
  if (w == null && typeof rec.size === 'number') { const r = Math.sqrt(rec.size) / 2; w = r * 2; h = r * 2; return { x1: x - r, y1: y - r, x2: x + r, y2: y + r } }
  if (w == null && rec.text != null) { const r = ((rec.fontSize as number | undefined) ?? 11) * String(rec.text).length * 0.3; w = r * 2; h = r }
  if (w == null || h == null) return null
  return { x1: Math.min(x, x + w), y1: Math.min(y, y + h), x2: Math.max(x, x + w), y2: Math.max(y, y + h) }
}

function overlaps(a: { x1: number; y1: number; x2: number; y2: number }, b: typeof a): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1
}

interface Tally { diffs: string[]; groups: number; items: number; attributes: number; marks: number; scales: number }

/**
 * Item equality is a multiset check; paint order is separately checked for
 * items whose painted extents actually overlap (the only place order changes
 * what a viewer sees).
 */
function compareLeafItems(real: readonly CItem[], ours: readonly CItem[], path: string, t: Tally): void {
  const realRecords = real.map((it) => it.record)
  const ourRecords = ours.map((it) => it.record)
  const rs = [...realRecords].sort()
  const os = [...ourRecords].sort()
  const n = Math.min(real.length, ours.length)
  t.items += n
  for (let i = 0; i < n; i++) t.attributes += Math.max(real[i]!.fields, ours[i]!.fields)
  if (rs.length !== os.length) t.diffs.push(`${path}: item count ${rs.length} vs ${os.length}`)
  let reported = 0
  for (let i = 0; i < Math.max(rs.length, os.length); i++) {
    if (rs[i] !== os[i] && reported++ < 6) t.diffs.push(`${path} item: ${rs[i] ?? '<none>'}  |  ${os[i] ?? '<none>'}`)
  }
  if (rs.length !== os.length) return
  // Paint order only matters where bounding boxes overlap. Match records to
  // their occurrence indices in both arrays, then compare relative order.
  const firstReal = new Map<string, number>()
  const firstOur = new Map<string, number>()
  realRecords.forEach((r, i) => { if (!firstReal.has(r)) firstReal.set(r, i) })
  ourRecords.forEach((r, i) => { if (!firstOur.has(r)) firstOur.set(r, i) })
  for (let i = 0; i < real.length; i++) {
    const bi = itemBounds(real[i]!.item)
    if (!bi) continue
    for (let j = i + 1; j < real.length; j++) {
      const bj = itemBounds(real[j]!.item)
      if (!bj || !overlaps(bi, bj)) continue
      const ri = firstReal.get(realRecords[i]!)
      const rj = firstReal.get(realRecords[j]!)
      const oi = firstOur.get(realRecords[i]!)
      const oj = firstOur.get(realRecords[j]!)
      if (ri == null || rj == null || oi == null || oj == null) continue
      if ((ri - rj) * (oi - oj) < 0) {
        t.diffs.push(`${path}: paint order differs for overlapping items (${realRecords[i]!.slice(0, 60)} / ${realRecords[j]!.slice(0, 60)})`)
        return
      }
    }
  }
}

/** Compare the marks of one scope, in paint order, and everything below them. */
function compareScope(real: readonly CMark[], ours: readonly CMark[], path: string, t: Tally): void {
  const rk = real.map((m) => m.key)
  const ok = ours.map((m) => m.key)
  if (rk.join(',') !== ok.join(',')) t.diffs.push(`${path || '/'}: marks in paint order ${JSON.stringify(rk)} vs ${JSON.stringify(ok)}`)
  // (marks are partnered by kind and occurrence, so one missing mark does not misalign every mark after it)
  const seen = new Map<string, number>()
  const partner = new Map<string, CMark[]>()
  for (const m of ours) partner.set(m.key, [...(partner.get(m.key) ?? []), m])
  for (const m of real) {
    const k = seen.get(m.key) ?? 0
    seen.set(m.key, k + 1)
    const o = partner.get(m.key)?.[k]
    const at = `${path}/${m.key}#${k}`
    if (o === undefined) continue
    t.marks++
    if (m.key.endsWith('|group')) {
      if (m.items.length !== o.items.length) t.diffs.push(`${at}: group item count ${m.items.length} vs ${o.items.length}`)
      m.items.forEach((ri, i) => {
        const oi = o.items[i]
        if (oi === undefined) return
        t.groups++
        t.items++
        t.attributes += Math.max(ri.fields, oi.fields)
        const here = `${at}[${i}]`
        if (ri.record !== oi.record) t.diffs.push(`${here} group item: ${ri.record}  |  ${oi.record}`)
        t.scales += compareScales(ri.scales ?? [], oi.scales ?? [], here, t.diffs)
        compareScope(ri.marks ?? [], oi.marks ?? [], here, t)
      })
    } else compareLeafItems(m.items, o.items, at, t)
  }
}

/**
 * Compare one spec (already Vega) through real Vega and the engine.
 * `adjustOurs` sees Aster's scene before it is compared: the gate's `--plant-difference` (scripts/scene-diff.mts) moves an
 * item there to prove the comparison and the exit path can fail.
 */
export async function sceneDiff(spec: Record<string, unknown>, adjustOurs?: (scene: SceneRoot) => void): Promise<SceneDiffResult> {
  // URL datasets are part of the resolved scene; resolve them exactly as the
  // renderer would before comparing.
  // (vega changes the rows of an inline dataset in place -- a force layout rewrites its link rows -- so each engine gets its own copy)
  const [oracleSpec, ourSpec] = forEngines(await loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS) as unknown as Record<string, unknown>, (oracle, aster) => [oracle, aster] as const)
  const runtime = vega.parse(oracleSpec as never)
  const view = new (vega as any).View(runtime, { renderer: 'none' })
  const t: Tally = { diffs: [], groups: 0, items: 0, attributes: 0, marks: 0, scales: 0 }
  let oracleItems = 0
  try {
    await view.runAsync()
    // vega's root is the frame mark; its one item is the root group, whose items are the view's marks
    const rootItem = ((view.scenegraph().root as SceneGroup).items ?? [])[0] as SceneNode | undefined
    const real = rootItem ? vegaMarks(rootItem) : []
    oracleItems = countItems(real)
    const scene = evaluateChart(compileChart(ourSpec as never))
    adjustOurs?.(scene)
    const ours = asterMarks(scene.items)
    // Root scope scales come from the view's own runtime context (the scene's
    // context scales are operator wrappers; `_runtime.scales` is the root map).
    const rootScales = scaleSnapshots((view as unknown as { _runtime?: { scales?: Map<string, unknown> } })._runtime?.scales)
    t.scales += compareScales(rootScales, fromOurScales(scene.__scales ?? []), 'root', t.diffs)
    compareScope(real, ours, '', t)
  } finally {
    view.finalize()
  }
  return { diffs: t.diffs, groups: t.groups, items: t.items, attributes: t.attributes, marks: t.marks, scales: t.scales, oracleItems }
}
