/**
 * Conformance runner. For each corpus entry, renders the same Vega spec through
 * real vega (oracle) and through @aster/core, canonicalizes both SVGs, and
 * reports geometry parity.
 *
 * Corpus entries:
 *   corpus/*.vl.json — Vega-Lite specs (compiled via vega-lite.compile)
 *   corpus/*.vg.json — raw Vega specs
 *
 * M0 conventions: specs must set explicit numeric width/height and
 * `autosize: 'none'` so layout is deterministic and comparable.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster/core/geo' // registers d3-geo/d3-contour for geo/projection/contour specs
import '@aster/core/transforms' // registers kde/regression/loess/pack/treemap/wordcloud/voronoi
import { renderSpec } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { renderWithVega } from './render-vega.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

interface CorpusEntry {
  name: string
  kind: 'vl' | 'vg'
  spec: Record<string, unknown>
}

function loadCorpus(dir: string): CorpusEntry[] {
  const out: CorpusEntry[] = []
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.vl.json')) {
      const spec = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      out.push({ name: f.replace(/\.vl\.json$/, ''), kind: 'vl', spec })
    } else if (f.endsWith('.vg.json')) {
      const spec = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      out.push({ name: f.replace(/\.vg\.json$/, ''), kind: 'vg', spec })
    }
  }
  return out
}

function vegaSpecFor(entry: CorpusEntry): { spec: Record<string, unknown>; viaLite: boolean } {
  if (entry.kind === 'vg') return { spec: entry.spec, viaLite: false }
  const compiled = vl.compile(entry.spec as any).spec as unknown as Record<string, unknown>
  return { spec: compiled, viaLite: true }
}

async function runOne(entry: CorpusEntry): Promise<{ pass: boolean; diffs: string[]; error?: string }> {
  try {
    const { spec } = vegaSpecFor(entry)
    const [oracleSvg, ourSvg] = await Promise.all([
      renderWithVega(spec),
      // url datasets resolve through the load addon, exactly what a real host does
      loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS).then((loaded) => renderSpec(loaded as never)),
    ])
    const oracle = canonicalizeSvg(oracleSvg)
    const ours = canonicalizeSvg(ourSvg)
    const diffs = diffCanonical(oracle, ours)
    return { pass: diffs.length === 0, diffs }
  } catch (err) {
    return { pass: false, diffs: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export async function runCorpus(): Promise<boolean> {
  // ASTER_CORPUS_DIR picks another corpus directory (relative to the package),
  // e.g. `corpus-tz` for the time-zone matrix; the default is the main corpus.
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', process.env.ASTER_CORPUS_DIR ?? 'corpus')
  if (!existsSync(dir)) {
    console.error(`[conformance] corpus directory not found: ${dir}`)
    return false
  }
  const entries = loadCorpus(dir)
  // ASTER_CORPUS_FILTER narrows to names matching a regular expression (local debugging)
  const filter = process.env.ASTER_CORPUS_FILTER ? new RegExp(process.env.ASTER_CORPUS_FILTER) : null
  if (filter) entries.splice(0, entries.length, ...entries.filter((e) => filter.test(e.name)))
  if (!entries.length) {
    console.error('[conformance] corpus is empty')
    return false
  }

  let passed = 0
  const failures: Array<{ name: string; diffs: string[]; error?: string }> = []
  for (const entry of entries) {
    const result = await runOne(entry)
    if (result.pass) {
      passed++
      console.log(`PASS  ${entry.name}`)
    } else {
      failures.push({ name: entry.name, diffs: result.diffs, error: result.error })
      console.log(`FAIL  ${entry.name}`)
      if (result.error) console.log(`      error: ${result.error}`)
      for (const d of result.diffs.slice(0, 12)) console.log(`      ${d}`)
    }
  }

  console.log(`\n[conformance] ${passed}/${entries.length} passed`)
  if (failures.length) console.log(`[conformance] failing: ${failures.map((f) => f.name).join(', ')}`)
  return failures.length === 0
}

const ok = await runCorpus()
process.exit(ok ? 0 : 1)
