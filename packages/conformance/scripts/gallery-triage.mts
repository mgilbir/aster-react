/**
 * Triage aid for the gallery gate (not a gate): puts every spec the STATIC path did not pass into a root-cause category.
 *
 *   pnpm --filter @aster/conformance exec tsx scripts/gallery-triage.mts <gate-results.json> [out.json]
 *   (results written by `conformance:gallery --json=<file>`)
 *
 * Method. A category is a TESTED claim, not a guess from a message:
 *   - error      -> by the error message (the engine or @aster/vl refused the spec).
 *   - Vega-Lite  -> `runtime` when Aster's runtime already differs on the Vega that vega-lite itself compiled
 *                   (so @aster/vl is not involved), `compiler` when the runtime matches there and only the Vega
 *                   @aster/vl emitted differs.
 *   - fail       -> the first matching entry of SIGNATURES, each a normalisation that, applied to the aster-only and
 *                   oracle-only records, makes the two multisets equal (e.g. "drop a Z that precedes an M"); then the
 *                   FEATURES table (source features that were checked against representative specs); else `uncategorised`.
 * Categories are for splitting fixes into branches; a spec in one category may also have a second defect behind it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile as compileOurs } from '@aster/vl'
import { canonicalizeSvg } from '../src/normalize.js'
import { vegaSvg } from '../src/gallery/oracle.js'
import { BASE_URL, fileFetch, listGallery, readSpec, type Outcome } from '../src/gallery/lib.js'

const render = async (vg: unknown): Promise<string> =>
  renderSpec((await loadSpecData(JSON.parse(JSON.stringify(vg)), { ...TRUSTED_LOAD_OPTIONS, fetch: fileFetch, baseURL: BASE_URL })) as never) as string

/** Record-level normalisations: when they make the two sides equal, that is the whole difference. */
const SIGNATURES: Array<[string, string, (r: string) => string]> = [
  ['serialisation: text content escapes `"` as &quot; (vega leaves it raw)', 'quote', (r) => r.replace(/&quot;/g, '"')],
  ['path: a line/area with breaks closes each piece with Z (vega: M..L..M..L)', 'zbreak', (r) => r.replace(/Z(?=M)/g, '')],
  ['numbers: coordinates differ in the 3rd decimal (rounding / summation order)', 'round', (r) => r.replace(/-?\d+\.\d+/g, (m) => (Math.round(Number(m) * 100) / 100).toFixed(2))],
  ['arc: large-arc flag of an elliptical arc differs', 'arcflag', (r) => r.replace(/A([\d.]+),([\d.]+),0,[01],/g, 'A$1,$2,0,X,')],
  ['paint: an empty-string stroke (vega paints it) is dropped', 'strokeempty', (r) => r.replace(/stroke=;stroke-width=1\|\|/g, '').replace(/\|\|$/, '||')],
  ['image: href is not resolved against the loader baseURL (harness gives vega a baseURL)', 'imghref', (r) => r.replace(/href=https:\/\/gallery\.invalid\//g, 'href=')],
]

const counts = (a: string[]): Map<string, number> => { const m = new Map<string, number>(); for (const r of a) m.set(r, (m.get(r) ?? 0) + 1); return m }
function onlySides(o: string[], a: string[]): [string[], string[]] {
  const co = counts(o), ca = counts(a)
  return [o.filter((r) => (ca.get(r) ?? 0) < (co.get(r) ?? 0)), a.filter((r) => (co.get(r) ?? 0) < (ca.get(r) ?? 0))]
}
/** Cheap tags read off the differing records themselves (a spec can carry several). */
function tagsOf(o: string[], a: string[]): string[] {
  const [oo, oa] = onlySides(o, a)
  const tags: string[] = []
  if (oa.some((r) => /Z(?=M)/.test(r)) && !oo.some((r) => /Z(?=M)/.test(r))) tags.push('zbreak')
  if (oa.some((r) => r.includes('&quot;'))) tags.push('quote')
  if (oa.some((r) => r.includes('[object Object]'))) tags.push('gradient-fill-on-path')
  if (oo.some((r) => r.includes('stroke=;'))) tags.push('empty-stroke')
  return tags
}

function signatureOf(o: string[], a: string[]): string | null {
  const [oo, oa] = onlySides(o, a)
  if (!oo.length && !oa.length) return null
  for (const [label, , f] of SIGNATURES) {
    const [x, y] = onlySides(oo.map(f), oa.map(f))
    if (!x.length && !y.length) return label
  }
  return null
}

/** The Vega-Lite errors that are `@aster/vl` refusing a valid feature, and the runtime errors, by message. */
const ERROR_CLASSES: Array<[RegExp, string]> = [
  [/^\[aster\/vl\]/, 'error: @aster/vl rejects a valid Vega-Lite feature'],
  [/unsupported transform type|Unrecognized function|Disabled\./, 'error: runtime lacks a Vega transform / expression function / transform backend'],
  [/Projection type must be a name string|Missing required "sequence"|signal-valued url|Unrecognized signal name|Undefined data set name/, 'error: runtime rejects a spec value that vega takes from a signal / another dataset'],
]


type Json = Record<string, unknown>
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const sameRecords = (a: string[], b: string[]): boolean => a.length === b.length && a.every((r, i) => r === b[i])

/**
 * RUNTIME culprit: remove one component of the Vega (both engines see the same reduced spec); the components whose removal makes
 * the render equal are the ones the difference lives in. Tries each top-level mark (by type/name), then axes, legends, title,
 * the event handlers of the signals, and the datasets' transforms one dataset at a time.
 */
async function culprit(vg: Json): Promise<string | null> {
  const equal = async (v: Json): Promise<boolean> => {
    try { return sameRecords(canonicalizeSvg(await vegaSvg(clone(v))).records, canonicalizeSvg(await render(v)).records) } catch { return false }
  }
  const marks = (vg.marks as Json[] | undefined) ?? []
  const found: string[] = []
  for (let i = 0; i < marks.length; i++) {
    const v = clone(vg); (v.marks as Json[]).splice(i, 1)
    if (await equal(v)) found.push(`mark[${i}] ${String(marks[i]!.type)}${marks[i]!.name ? ` "${String(marks[i]!.name)}"` : ''}`)
  }
  for (const key of ['axes', 'legends', 'title', 'projections']) {
    if (vg[key] === undefined) continue
    const v = clone(vg); delete v[key]
    if (await equal(v)) found.push(`removing ${key}`)
  }
  if (!found.length && Array.isArray(vg.signals) && (vg.signals as Json[]).some((x) => x.on)) {
    const v = clone(vg); for (const x of v.signals as Json[]) delete x.on
    if (await equal(v)) found.push('signal event handlers')
  }
  return found.length ? found.join('; ') : null
}

/**
 * COMPILER culprit: graft one group of vega-lite's compiled Vega into @aster/vl's and see whether the render becomes the oracle's.
 * Groups: size/layout (signals, width, height, autosize, padding, layout), scales+guides (scales, axes, legends), data+marks,
 * title/config/projections. The smallest group (or pair) that fixes the render holds the defect.
 */
async function graft(ours: Json, ref: Json, oracle: string[]): Promise<string | null> {
  const GROUPS: Record<string, string[]> = {
    'size/layout (signals, width, height, autosize, padding, layout)': ['signals', 'width', 'height', 'autosize', 'padding', 'layout'],
    'scales+guides (scales, axes, legends)': ['scales', 'axes', 'legends'],
    'data+marks': ['data', 'marks'],
    'title/config/projections': ['title', 'config', 'projections', 'background'],
  }
  const names = Object.keys(GROUPS)
  const withGroups = async (ns: string[]): Promise<boolean> => {
    const g = clone(ours)
    for (const n of ns) for (const k of GROUPS[n]!) { if (ref[k] === undefined) delete g[k]; else g[k] = clone(ref[k]) }
    try { return sameRecords(canonicalizeSvg(await render(g)).records, oracle) } catch { return false }
  }
  for (const n of names) if (await withGroups([n])) return n
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (await withGroups([names[i]!, names[j]!])) return `${names[i]} + ${names[j]}`
  return null
}


/** Facts about the Vega the oracle ran (read off the spec; each was checked against representative specs, see the README). */
function vegaFlags(vg: Json): string[] {
  const flags: string[] = []
  const text = JSON.stringify(vg)
  const dataSets = (vg.data as Json[] | undefined) ?? []
  if (dataSets.some((d) => Array.isArray(d.values) && d.values.length > 0 && (d.values as unknown[]).every((v) => v === null || typeof v !== 'object'))) flags.push('primitive-values')
  if (/time\(datetime\(/.test(text)) flags.push('time()')
  const names = new Set<string>()
  const walk = (m: Json, f: (m: Json) => void): void => { f(m); for (const c of (m.marks as Json[] | undefined) ?? []) walk(c, f) }
  const topNames = new Set(dataSets.map((d) => String(d.name)))
  for (const m of (vg.marks as Json[] | undefined) ?? []) walk(m, (x) => { if (x.name) names.add(String(x.name)) })
  for (const m of (vg.marks as Json[] | undefined) ?? []) walk(m, (x) => {
    const d = (x.from as Json | undefined)?.data
    if (typeof d === 'string' && !topNames.has(d) && names.has(d)) flags.push('mark-name-data')
  })
  return flags
}

const results = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { static: Outcome[]; react?: Outcome[] }
const byId = new Map(listGallery().map((g) => [g.id, g]))
const out: Array<Record<string, unknown>> = []
for (const o of results.static) {
  if (o.status !== 'fail' && o.status !== 'error') continue
  const g = byId.get(o.id)!
  const rec: Record<string, unknown> = { id: o.id, kind: g.kind, status: o.status, first: o.first, firstContent: o.firstContent }
  const src = readSpec(g)
  if (o.status === 'error') {
    rec.category = ERROR_CLASSES.find(([re]) => re.test(o.first ?? ''))?.[1] ?? 'error: other'
    rec.where = rec.category === ERROR_CLASSES[0]![1] ? 'compiler' : 'runtime'
    out.push(rec)
    continue
  }
  try {
    const oracleVg = g.kind === 'vl' ? (vl.compile(src as never).spec as unknown as Json) : src
    const oracle = canonicalizeSvg(await vegaSvg(oracleVg))
    // a flag only counts when the claimed fix, applied to the Vega, makes Aster's render equal the oracle's
    const verified = async (rewrite: (v: Json) => Json): Promise<boolean> => {
      try { return sameRecords(oracle.records, canonicalizeSvg(await render(rewrite(clone(oracleVg)))).records) } catch { return false }
    }
    const flags = vegaFlags(oracleVg)
    rec.flags = []
    if (flags.includes('primitive-values') && await verified((v) => {
      for (const d of (v.data as Json[] | undefined) ?? []) if (Array.isArray(d.values)) d.values = d.values.map((x) => (x !== null && typeof x === 'object' ? x : { data: x }))
      return v
    })) (rec.flags as string[]).push('primitive-values')
    if (flags.includes('time()') && await verified((v) => JSON.parse(JSON.stringify(v).replace(/\btime\(/g, 'toNumber(')) as Json)) (rec.flags as string[]).push('time()')
    if (flags.includes('mark-name-data')) (rec.flags as string[]).push('mark-name-data')
    if (g.kind === 'vl') {
      // is Aster's RUNTIME already different on vega-lite's own Vega?
      let ref: string[] | null = null
      try { ref = canonicalizeSvg(await render(oracleVg)).records } catch { ref = null }
      const same = ref !== null && sameRecords(ref, oracle.records)
      rec.where = same ? 'compiler' : 'runtime'
      const ourVg = compileOurs(JSON.parse(JSON.stringify(src))) as Json
      const ours = canonicalizeSvg(await render(ourVg)).records
      const compared = same ? ours : ref ?? ours
      rec.signature = signatureOf(oracle.records, compared)
      rec.tags = tagsOf(oracle.records, compared)
      if (!rec.signature) rec.culprit = same ? await graft(ourVg, oracleVg, oracle.records) : await culprit(oracleVg)
    } else {
      rec.where = 'runtime'
      const vr = canonicalizeSvg(await render(src)).records
      rec.signature = signatureOf(oracle.records, vr)
      rec.tags = tagsOf(oracle.records, vr)
      if (!rec.signature) rec.culprit = await culprit(src)
    }
  } catch (e) { rec.note = (e as Error).message.slice(0, 120) }
  // the category: tested signatures first, then flags read off the Vega, then the located component
  const flags = (rec.flags as string[] | undefined) ?? []
  const tags = (rec.tags as string[] | undefined) ?? []
  const culpritText = String(rec.culprit ?? '')
  rec.category =
    rec.where === 'compiler' ? `compiler: ${culpritText || 'not isolated by grafting'}`
    : flags.includes('primitive-values') ? 'runtime: inline primitive `values` are not wrapped as {data: v}'
    : flags.includes('time()') ? 'runtime: expression `time(x)` returns a Date, not a timestamp'
    : flags.includes('mark-name-data') ? 'runtime: a mark reading `from: {data: <mark name>}` (a group mark\'s items) draws nothing'
    : typeof rec.signature === 'string' ? `runtime: ${rec.signature}`
    : tags.includes('gradient-fill-on-path') ? 'runtime: gradient fill object stringified on a path (area/line)'
    : /shape|projection/.test(culpritText) ? 'runtime: geo (shape marks / projection fit), root size off by 1-2 px'
    : /group "?\w*cell|trellis|facet/.test(culpritText) ? 'runtime: facet / cell group layout or order'
    : /text/.test(culpritText) ? 'runtime: a text mark positioned from an undefined signal changes the autosize bounds'
    : /axes|title/.test(culpritText) ? `runtime: guide (${culpritText})`
    : `runtime: other (${culpritText || 'not isolated'})`
  out.push(rec)
}
writeFileSync(process.argv[3] ?? '/dev/stdout', JSON.stringify(out, null, 1))

// the table
const rows = new Map<string, Array<Record<string, unknown>>>()
for (const r of out) { const k = String(r.category); rows.set(k, [...(rows.get(k) ?? []), r]) }
console.log('| count | category | representative | first diff |\n|---|---|---|---|')
for (const [k, v] of [...rows].sort((a, b) => b[1].length - a[1].length)) console.log(`| ${v.length} | ${k} | ${String(v[0]!.id)} | ${String(v[0]!.firstContent ?? v[0]!.first ?? '').replace(/\|/g, '/').slice(0, 110)} |`)
if (results.react) {
  const st = new Map(results.static.map((o) => [o.id, o.status]))
  const x = new Map<string, number>()
  for (const o of results.react) x.set(`${st.get(o.id)} -> ${o.status}`, (x.get(`${st.get(o.id)} -> ${o.status}`) ?? 0) + 1)
  console.log('\nstatic -> react status:', JSON.stringify(Object.fromEntries(x)))
}
process.exit(0)
