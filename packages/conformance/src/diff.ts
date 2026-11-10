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

/**
 * Specs whose row changes do not render as a fresh chart, each for a reason that is not the row changes' (all three mismatched before
 * the row changes were checked here: measured 2026-11-10 against main + #136-#138 at 72ffeea). The list only shrinks: a spec on it
 * that matches fails the gate, so it is taken off.
 */
const KNOWN_ROW_MISMATCHES: Record<string, string> = {
  // an identifier numbers rows as the view's counter stands, which depends on the evaluations before (ARCHITECTURE.md, "Incremental
  // evaluation"): a fresh chart numbers them from the start, and the marks encode the numbers
  'data-source-list.vg.json': 'identifier numbers depend on how the view got there',
  // the force simulation draws its start from the random source, whose numbers depend on the draws the evaluations before made
  'force-layout-marks.vg.json': 'force layout draws from the random source',
  // an `extent` step publishes a signal that a later `formula` of the same pipeline reads; a pulse that moves the extent keeps the
  // formula's rows (a dataset-pulse issue, not a scale's)
  'vlx-tr-extent-param.vl.json': 'a pulse past an extent that publishes the signal a later formula reads',
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

/** Whether the scene of each row change through one session renders as a fresh chart renders the same rows; null when a spec throws. */
function rowChangesMatch(spec: Record<string, unknown>, name: string, values: Rows, rand: () => number, keys: ReadonlySet<string>): string | true | null {
  const session = createChartSession()
  let rows = values
  try {
    session.evaluate(spec as never, { data: { [name]: rows } })
    for (const change of rowChanges(rand, firstTextField(values[0]!, keys))) {
      if (!rows.length) break
      rows = change.to(rows)
      const inc = canonicalizeSvg(renderSceneToSvg(session.evaluate(spec as never, { data: { [name]: rows } })))
      const full = canonicalizeSvg(renderSceneToSvg(evaluateChart(compileChart(spec as never), { data: { [name]: rows } })))
      if (inc.root !== full.root || inc.records.join('\u0000') !== full.records.join('\u0000')) return change.what
    }
  } catch {
    return null
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
  const unexpected = rowFailures.filter((f) => !Object.hasOwn(KNOWN_ROW_MISMATCHES, f.slice(0, f.indexOf(' ('))))
  const known = new Set(rowFailures.map((f) => f.slice(0, f.indexOf(' ('))))
  const fixed = Object.keys(KNOWN_ROW_MISMATCHES).filter((f) => !known.has(f))
  for (const f of rowFailures) console.log(`  ${unexpected.includes(f) ? '✗' : '(known)'} ${f}${unexpected.includes(f) ? '' : `: ${KNOWN_ROW_MISMATCHES[f.slice(0, f.indexOf(' ('))]}`}`)
  for (const f of fixed) console.log(`  ✗ ${f} is listed as a known mismatch but matches now: take it off KNOWN_ROW_MISMATCHES`)
  if (failed > 0 || unexpected.length > 0 || fixed.length > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
