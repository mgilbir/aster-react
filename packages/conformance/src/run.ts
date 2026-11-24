/**
 * Conformance runner. For each corpus entry, renders the same Vega spec through
 * real vega (oracle) and through @aster-charts/core, canonicalizes both SVGs, and
 * reports geometry parity.
 *
 * Corpus entries:
 *   corpus/*.vl.json — Vega-Lite specs (compiled via vega-lite.compile)
 *   corpus/*.vg.json — raw Vega specs
 *
 * Environment: ASTER_CORPUS_DIR picks another corpus directory, relative to the package (default `corpus`; the time-zone matrix uses
 * `corpus-tz`); ASTER_CORPUS_FILTER keeps the entries whose name matches the regular expression (a narrowed run: the floor is
 * not applied, but a filter that matches nothing fails).
 * The verdict is runGate's (scripts/lib/run-gate.mjs): every entry is compared, and the number compared has a floor per corpus
 * directory (FLOORS: today's counts, which only ratchet up).
 * Exit codes: 0 every entry matches the oracle, 1 a difference, an error or a broken floor, 2 bad usage (an unknown option or
 * an ASTER_CORPUS_DIR with no floor).
 * Run after `pnpm build` (it renders through @aster-charts/core's dist).
 *
 * Convention: most entries set explicit numeric width/height and `autosize: 'none'` so
 * layout is deterministic and comparable. Nothing enforces it, and not every entry
 * follows it: some use another autosize or have no numeric width/height.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster-charts/core/geo' // registers the geo projections and contours for geo/projection/contour specs
import '@aster-charts/core/transforms' // registers kde/regression/loess/pack/treemap/wordcloud/voronoi
import { renderSpec } from '@aster-charts/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { renderWithVega } from './render-vega.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { plantSvg } from './gate-plant.js'
import { deepFreeze, forEngines } from './engines.js'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'

cli({ url: import.meta.url, flags: GATE_FLAGS })

/** The number of entries each corpus directory compares on a full run (today's counts; they only ratchet up). */
const FLOORS: Record<string, number> = { corpus: 1063, 'corpus-tz': 28 }

interface CorpusEntry {
  name: string
  kind: 'vl' | 'vg'
  spec: Record<string, unknown>
}

function loadCorpus(dir: string): CorpusEntry[] {
  const out: CorpusEntry[] = []
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.vl.json')) {
      const spec = deepFreeze(JSON.parse(readFileSync(join(dir, f), 'utf8')))
      out.push({ name: f.replace(/\.vl\.json$/, ''), kind: 'vl', spec })
    } else if (f.endsWith('.vg.json')) {
      // (frozen: the source each engine copies from; a path that handed it to vega itself would fail at vega's first write)
      const spec = deepFreeze(JSON.parse(readFileSync(join(dir, f), 'utf8')))
      out.push({ name: f.replace(/\.vg\.json$/, ''), kind: 'vg', spec })
    }
  }
  return out
}

function vegaSpecFor(entry: CorpusEntry): { spec: Record<string, unknown>; viaLite: boolean } {
  if (entry.kind === 'vg') return { spec: entry.spec, viaLite: false }
  const compiled = vl.compile(structuredClone(entry.spec) as any).spec as unknown as Record<string, unknown>
  return { spec: compiled, viaLite: true }
}

async function runOne(entry: CorpusEntry, plant: boolean): Promise<{ pass: boolean; diffs: string[]; error?: string }> {
  try {
    const { spec } = vegaSpecFor(entry)
    // (each engine its own copy: vega writes onto the rows it ingests -- a stack's y0/y1, a force layout's link rows)
    const [oracleSvg, ourSvg] = await forEngines(spec, (oracle, aster) => Promise.all([
      renderWithVega(oracle),
      // url datasets resolve through the load addon, exactly what a real host does
      loadSpecData(aster as never, TRUSTED_LOAD_OPTIONS).then((loaded) => renderSpec(loaded as never)),
    ]))
    const ours = canonicalizeSvg(plant ? plantSvg(ourSvg) : ourSvg)
    const oracle = canonicalizeSvg(oracleSvg)
    const diffs = diffCanonical(oracle, ours)
    return { pass: diffs.length === 0, diffs }
  } catch (err) {
    return { pass: false, diffs: [], error: err instanceof Error ? err.message : String(err) }
  }
}

async function runCorpus(gate: Gate, dir: string, filter: RegExp | null): Promise<void> {
  if (!existsSync(dir)) throw new Error(`corpus directory not found: ${dir}`)
  const entries = loadCorpus(dir).filter((e) => !filter || filter.test(e.name))
  let passed = 0
  for (const entry of entries) {
    const result = await runOne(entry, gate.plant)
    if (result.error !== undefined) {
      gate.error(entry.name, result.error)
      console.log(`FAIL  ${entry.name}\n      error: ${result.error}`)
    } else if (!result.pass) {
      gate.differ(entry.name, result.diffs[0] ?? 'differs')
      console.log(`FAIL  ${entry.name}`)
      for (const d of result.diffs.slice(0, 12)) console.log(`      ${d}`)
    } else {
      passed++
      gate.agree(entry.name)
      console.log(`PASS  ${entry.name}`)
    }
  }
  console.log(`\n[conformance] ${passed}/${entries.length} passed`)
}

// ASTER_CORPUS_DIR picks another corpus directory (relative to the package), e.g. `corpus-tz` for the time-zone matrix.
const corpusName = process.env.ASTER_CORPUS_DIR ?? 'corpus'
const floor = FLOORS[corpusName]
if (floor === undefined) {
  console.error(`[conformance] ASTER_CORPUS_DIR=${corpusName} has no floor in FLOORS (${Object.keys(FLOORS).join(', ')})`)
  process.exit(2)
}
// ASTER_CORPUS_FILTER narrows to names matching a regular expression (local debugging)
const filter = process.env.ASTER_CORPUS_FILTER ? new RegExp(process.env.ASTER_CORPUS_FILTER) : null
await runGate({
  name: 'conformance',
  counters: { compared: { floor, what: `${corpusName} entries compared with the oracle's SVG` } },
  partial: filter !== null,
  run: (gate) => runCorpus(gate, join(dirname(fileURLToPath(import.meta.url)), '..', corpusName), filter),
})
