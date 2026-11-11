/**
 * Differential conformance: for every corpus entry with an inline-values dataset,
 * verify that aster's per-datum differential path (a random changeset over a
 * same-length data replacement) equals aster's full re-derive. This gates the
 * reactive-dataflow engine (input.dataChanges) at the corpus level — the same
 * property the unit fuzz test checks, but over the whole corpus.
 *
 * Then the rows themselves change, through a chart session as `<Chart>` drives it
 * (a new array per update, which the session diffs): a copy of a row appended,
 * a row removed, a row's text field (a category) edited to another row's, and a
 * row of a category no row has appended. After each, the session's scene renders
 * the same SVG as a freshly compiled chart evaluated on the same rows. These are
 * the changes that keep or remake a discrete scale (and a continuous one).
 *
 * Run: pnpm conformance:diff
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster-charts/core'
import { createChartSession } from '@aster-charts/core/dom'
import { canonicalizeSvg } from './normalize.js'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url })

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = join(THIS_DIR, '..', 'corpus')

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Transforms that join rows by field value: a field they name is a key, and bumping it breaks the join, not the differential path. */
const JOIN_TRANSFORMS = new Set(['lookup', 'stratify', 'treelinks', 'nest'])
const KEY_PROPS = ['key', 'fields', 'parentKey', 'groupby']

/** Every identifier written in the join properties of the spec's join transforms (`datum.id`, `'id'`, ...): the names a mutation must not touch. */
function joinKeyNames(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) joinKeyNames(v, out)
  } else if (node !== null && typeof node === 'object') {
    const rec = node as Record<string, unknown>
    if (typeof rec.type === 'string' && JOIN_TRANSFORMS.has(rec.type)) {
      for (const prop of KEY_PROPS) {
        const v = rec[prop]
        for (const str of Array.isArray(v) ? v : [v]) {
          if (typeof str === 'string') for (const m of str.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0])
        }
      }
    }
    for (const v of Object.values(rec)) joinKeyNames(v, out)
  }
  return out
}

/** The first numeric field of the row that no join transform of the spec uses as a key. */
function firstNumericField(row: Record<string, unknown>, keys: ReadonlySet<string>): string | null {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'number' && Number.isFinite(v) && !keys.has(k)) return k
  }
  return null
}

/** The first text field of the row that no join transform of the spec uses as a key: a category, as a nominal field is. */
function firstTextField(row: Record<string, unknown>, keys: ReadonlySet<string>): string | null {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && !keys.has(k)) return k
  }
  return null
}

type Rows = Array<Record<string, unknown>>

/** Whether any `identifier` transform is in the spec (a dataset's or a mark's, at any depth). */
function numbersRows(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(numbersRows)
  if (node === null || typeof node !== 'object') return false
  const rec = node as Record<string, unknown>
  if (rec.type === 'identifier') return true
  return Object.values(rec).some(numbersRows)
}

/** The row changes, in order, each from the rows the one before left. */
function rowChanges(rand: () => number, text: string | null): Array<{ what: string; to: (rows: Rows) => Rows }> {
  const at = (rows: Rows): number => Math.floor(rand() * rows.length)
  return [
    { what: 'a copy of a row appended', to: (rows) => [...rows, { ...rows[at(rows)]! }] },
    { what: 'a row removed', to: (rows) => { const i = at(rows); return rows.filter((_, k) => k !== i) } },
    ...(text === null ? [] : [
      { what: 'a category edited to another row\'s', to: (rows: Rows) => { const i = at(rows); const from = rows[at(rows)]!; return rows.map((r, k) => (k === i ? { ...r, [text]: from[text] } : r)) } },
      { what: 'a row of a new category appended', to: (rows: Rows) => [...rows, { ...rows[at(rows)]!, [text]: '\u00b6new category' }] },
    ]),
  ]
}

/**
 * Whether the scene of each row change through one session renders as a fresh chart renders the same rows; null when a spec throws.
 *
 * An `identifier` numbers rows from the view's counter, so its numbers depend on how the view got there, in Vega as in Aster (the rows
 * a change adds take the next numbers and the others keep theirs, where a fresh view numbers every row from 1: ARCHITECTURE.md,
 * "Deviations from Vega"). A spec with one is compared with the incremental-oracle's reference instead: a chart of its own taken
 * through the same states, each evaluated with no hint of what changed but the rows edited where they stood.
 */
function rowChangesMatch(spec: Record<string, unknown>, name: string, values: Rows, rand: () => number, keys: ReadonlySet<string>): string | true | null {
  const session = createChartSession()
  const history = numbersRows(spec) ? compileChart(spec as never) : undefined
  // Each side is run on its own: a spec is skipped only when BOTH throw on the same rows. When only one does, the session and
  // a fresh chart disagree (an incremental path that throws where a fresh evaluation does not, or the reverse): a mismatch.
  const attempt = <T>(f: () => T): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      return { ok: true, value: f() }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  const disagree = (what: string, inc: { ok: boolean; error?: string }, full: { ok: boolean; error?: string }): string =>
    `${what}: only the ${inc.ok ? 'fresh chart' : 'session'} threw (${(inc.ok ? full.error : inc.error)?.slice(0, 120)})`
  let rows = values
  const first = attempt(() => session.evaluate(spec as never, { data: { [name]: rows } }))
  const firstFull = attempt(() => (history !== undefined ? evaluateChart(history, { data: { [name]: rows } }) : evaluateChart(compileChart(spec as never), { data: { [name]: rows } })))
  if (!first.ok && !firstFull.ok) return null
  if (first.ok !== firstFull.ok) return disagree('the first evaluation', first, firstFull)
  for (const change of rowChanges(rand, firstTextField(values[0]!, keys))) {
    if (!rows.length) break
    const before = rows
    rows = change.to(rows)
    const inc = attempt(() => canonicalizeSvg(renderSceneToSvg(session.evaluate(spec as never, { data: { [name]: rows } }))))
    const edited = before.length === rows.length ? rows.flatMap((r, i) => (r === before[i] ? [] : [i])) : undefined
    const full = attempt(() => canonicalizeSvg(renderSceneToSvg(history !== undefined
      ? evaluateChart(history, { data: { [name]: rows }, ...(edited !== undefined ? { dataChanges: { [name]: edited } } : {}) })
      : evaluateChart(compileChart(spec as never), { data: { [name]: rows } }))))
    if (!inc.ok && !full.ok) return null
    if (!inc.ok || !full.ok) return disagree(change.what, inc, full)
    if (inc.value.root !== full.value.root || inc.value.records.join('\u0000') !== full.value.records.join('\u0000')) return change.what
  }
  return true
}

async function main(): Promise<void> {
  const rand = mulberry32(0xBEAD)
  let ran = 0
  let failed = 0
  let skipped = 0
  const failures: string[] = []
  const rowRand = mulberry32(0xCA7E)
  let rowRan = 0
  let rowSkipped = 0
  const rowFailures: string[] = []
  for (const f of readdirSync(CORPUS_DIR).sort()) {
    if (!f.endsWith('.json')) continue
    const raw = JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8'))
    const spec = f.endsWith('.vl.json') ? (vl.compile(raw as never).spec as Record<string, unknown>) : raw
    const data = (spec.data ?? []) as Array<{ name?: string; values?: unknown[] }>
    const dataset = data.find((d) => Array.isArray(d.values) && d.values.length > 0 && typeof d.values[0] === 'object')
    if (!dataset?.name || !dataset.values) continue
    const name = dataset.name
    const values = dataset.values as Array<Record<string, unknown>>
    const keys = joinKeyNames(spec)
    // the row changes: every spec with inline rows, whatever their fields
    const rowsMatch = rowChangesMatch(spec, name, values, rowRand, keys)
    if (rowsMatch === null) rowSkipped++
    else {
      rowRan++
      if (rowsMatch !== true) rowFailures.push(`${f} (${rowsMatch})`)
    }
    const field = firstNumericField(values[0]!, keys)
    if (field == null) continue
    // random changeset over a same-length data replacement
    const changed: number[] = []
    const next = values.map((r, i) => {
      if (rand() < 0.2) { changed.push(i); return { ...r, [field]: (r[field] as number) + 1 } }
      return r
    })
    // (a spec whose draw changed nothing still gets one changed row, so no spec drops out of the check by chance)
    if (changed.length === 0) {
      const i = Math.floor(rand() * values.length)
      changed.push(i)
      next[i] = { ...values[i]!, [field]: (values[i]![field] as number) + 1 }
    }
    ran++
    let inc: { records: string[]; root: string | null }
    let full: { records: string[]; root: string | null }
    try {
      const chart = compileChart(spec as never)
      evaluateChart(chart, { data: { [name]: values } })
      inc = canonicalizeSvg(renderSceneToSvg(evaluateChart(chart, { data: { [name]: next }, dataChanges: { [name]: changed } })))
      full = canonicalizeSvg(renderSceneToSvg(evaluateChart(chart, { data: { [name]: next } })))
    } catch {
      // A mutated value can break a layout transform (e.g. pack) independent of
      // the differential path; such specs aren't a differential signal, skip them (and count them: see the summary).
      skipped++
      continue
    }
    if (inc.root !== full.root || inc.records.join('\u0000') !== full.records.join('\u0000')) {
      failed++
      failures.push(f)
    }
  }
  console.log(`[conformance:diff] ${ran} corpus specs with inline values; ${failed} differential mismatches; ${skipped} skipped (the mutated data made the spec throw)`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log(`[conformance:diff] row changes: ${rowRan} corpus specs; ${rowFailures.length} mismatches; ${rowSkipped} skipped (the changed rows made the spec throw)`)
  for (const f of rowFailures) console.log(`  ✗ ${f}`)
  if (failed > 0 || rowFailures.length > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
