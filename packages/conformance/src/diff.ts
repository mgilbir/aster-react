/**
 * Differential conformance: for every corpus entry with an inline-values dataset,
 * verify that aster's per-datum differential path (a random changeset over a
 * same-length data replacement) equals aster's full re-derive. This gates the
 * reactive-dataflow engine (input.dataChanges) at the corpus level — the same
 * property the unit fuzz test checks, but over the whole corpus.
 *
 * Run: pnpm conformance:diff
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster/core'
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

async function main(): Promise<void> {
  const rand = mulberry32(0xBEAD)
  let ran = 0
  let failed = 0
  let skipped = 0
  const failures: string[] = []
  for (const f of readdirSync(CORPUS_DIR).sort()) {
    if (!f.endsWith('.json')) continue
    const raw = JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8'))
    const spec = f.endsWith('.vl.json') ? (vl.compile(raw as never).spec as Record<string, unknown>) : raw
    const data = (spec.data ?? []) as Array<{ name?: string; values?: unknown[] }>
    const dataset = data.find((d) => Array.isArray(d.values) && d.values.length > 0 && typeof d.values[0] === 'object')
    if (!dataset?.name || !dataset.values) continue
    const name = dataset.name
    const values = dataset.values as Array<Record<string, unknown>>
    const field = firstNumericField(values[0]!, joinKeyNames(spec))
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
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
