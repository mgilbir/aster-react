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
 * Over the whole default corpus no two entries may render alike beyond corpus-identical.json, and no entry may draw no item of its own
 * beyond corpus-no-items.json (both tables exact in both directions: corpus-distinct.ts).
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
import { renderWithVegaCounted, settleWithin } from './render-vega.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { canonicalHash, checkIdentical, checkNoItems, groupIdentical, readIdenticalTable, readNoItemsTable } from './corpus-distinct.js'
import { plantSvg } from './gate-plant.js'
import { deepFreeze, forEngines } from './engines.js'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'

cli({ url: import.meta.url, flags: GATE_FLAGS })

/** The number of entries each corpus directory compares on a full run (today's counts; they only ratchet up). */
const FLOORS: Record<string, number> = { corpus: 1120, 'corpus-tz': 29 }

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

async function runOne(entry: CorpusEntry, plant: boolean): Promise<{ pass: boolean; diffs: string[]; error?: string; oracleHash?: string; markItems?: number }> {
  try {
    const { spec } = vegaSpecFor(entry)
    // (each engine its own copy: vega writes onto the rows it ingests -- a stack's y0/y1, a force layout's link rows)
    const [oracleRender, ourSvg] = await forEngines(spec, (oracle, aster) => Promise.all([
      renderWithVegaCounted(oracle),
      // url datasets resolve through the load addon, exactly what a real host does
      settleWithin(loadSpecData(aster as never, TRUSTED_LOAD_OPTIONS), "Aster's data load").then((loaded) => renderSpec(loaded as never)),
    ]))
    const ours = canonicalizeSvg(plant ? plantSvg(ourSvg) : ourSvg)
    const oracle = canonicalizeSvg(oracleRender.svg)
    const diffs = diffCanonical(oracle, ours)
    return { pass: diffs.length === 0, diffs, oracleHash: canonicalHash(oracle), markItems: oracleRender.markItems }
  } catch (err) {
    return { pass: false, diffs: [], error: err instanceof Error ? err.message : String(err) }
  }
}

async function runCorpus(gate: Gate, dir: string, filter: RegExp | null): Promise<void> {
  if (!existsSync(dir)) throw new Error(`corpus directory not found: ${dir}`)
  const entries = loadCorpus(dir).filter((e) => !filter || filter.test(e.name))
  let passed = 0
  const hashes = new Map<string, string>()
  const noItems: string[] = []
  for (const entry of entries) {
    const result = await runOne(entry, gate.plant)
    if (result.oracleHash) hashes.set(entry.name, result.oracleHash)
    if (result.markItems === 0) noItems.push(entry.name)
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
  // The corpus is a set of distinct checks that each compare something of the data: only the whole default corpus can be held to that
  // (a filter or another directory renders a part).
  if (!filter && !process.env.ASTER_CORPUS_DIR) {
    const here = join(dirname(fileURLToPath(import.meta.url)), '..')
    const names = new Set(entries.map((e) => e.name))
    const identical = readIdenticalTable(join(here, 'corpus-identical.json'))
    const empty = readNoItemsTable(join(here, 'corpus-no-items.json'))
    const problems = [
      ...checkIdentical(groupIdentical(hashes), identical, names),
      ...checkNoItems(noItems, empty, names),
    ]
    for (const p of problems) { console.log(`FAIL  ${p}`); gate.problem(p) }
    console.log(
      `[conformance] distinct: ${problems.length ? `${problems.length} problem(s)` : `ok (${identical.groups.length} known identical group(s) still to fix, ${empty.specs.length} entry(ies) listed as drawing no item of their own)`}`,
    )
  }
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
