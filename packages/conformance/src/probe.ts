/**
 * Feature-gap probe runner. Same oracle diff as the conformance run, but pointed
 * at `probes/` — specs that exercise feature areas the corpus doesn't cover yet.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs). A probe that fails documents a gap only when it is listed in the
 * expected-differences table (scripts/lib/expected-differences.mjs, gate `probe`), which requires it to STILL fail: a listed
 * probe that passes fails the gate until it is promoted to `corpus/` and its entry removed. Any other failing probe is a
 * failure. `--min-pass N` is the floor on the number of probes compared (the gate runs with today's number); a run that
 * compares none fails.
 *
 * Usage: pnpm probe [name-filter] [--min-pass N]   (run after `pnpm build`)
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
import { parseProbeArgs } from './probe-verdict.js'
import { plantSvg } from './gate-plant.js'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'

cli({ url: import.meta.url, flags: { 'min-pass': 'both', ...GATE_FLAGS }, args: '[name-filter]' })

interface ProbeEntry {
  name: string
  kind: 'vl' | 'vg'
  spec: Record<string, unknown>
}

function loadProbes(dir: string): ProbeEntry[] {
  const out: ProbeEntry[] = []
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.vl.json')) {
      out.push({ name: f.replace(/\.vl\.json$/, ''), kind: 'vl', spec: JSON.parse(readFileSync(join(dir, f), 'utf8')) })
    } else if (f.endsWith('.vg.json')) {
      out.push({ name: f.replace(/\.vg\.json$/, ''), kind: 'vg', spec: JSON.parse(readFileSync(join(dir, f), 'utf8')) })
    }
  }
  return out
}

async function runOne(entry: ProbeEntry, plant: boolean) {
  try {
    const spec = entry.kind === 'vg' ? entry.spec : (vl.compile(entry.spec as any).spec as unknown as Record<string, unknown>)
    const [oracleSvg, ourSvg] = await Promise.all([
      renderWithVega(spec),
      // url datasets resolve through the load addon, exactly what a real host does
      loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS).then((loaded) => renderSpec(loaded as never)),
    ])
    const diffs = diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(plant ? plantSvg(ourSvg) : ourSvg))
    return { pass: diffs.length === 0, diffs }
  } catch (err) {
    return { pass: false, diffs: [], error: err instanceof Error ? err.message : String(err) }
  }
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes')
let parsed: ReturnType<typeof parseProbeArgs>
try {
  parsed = parseProbeArgs(process.argv.slice(2).filter((a) => a !== '--plant-difference'))
} catch (e) {
  console.error(`[probe] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
}
const { filter, minPass } = parsed

async function main(gate: Gate): Promise<void> {
  if (!existsSync(dir)) throw new Error(`probes directory not found: ${dir}`)
  const entries = loadProbes(dir).filter((e) => !filter || e.name.includes(filter))
  let passed = 0
  for (const entry of entries) {
    const r = await runOne(entry, gate.plant)
    let note = ''
    if (!r.pass) {
      if (r.error) note = r.error.split('\n')[0]!.slice(0, 120)
      else note = r.diffs[0]?.slice(0, 120) ?? ''
    }
    if (r.error !== undefined) gate.error(entry.name, note)
    else if (!r.pass) gate.differ(entry.name, note)
    else {
      passed++
      gate.agree(entry.name)
    }
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${entry.name}${note ? `  — ${note}` : ''}`)
    if (!r.pass && !r.error) for (const d of r.diffs.slice(1, 4)) console.log(`      ${d}`)
  }
  console.log(`\n[probe] ${passed}/${entries.length} passed`)
}

await runGate({
  name: 'probe',
  counters: { compared: { floor: minPass ?? 0, what: 'probes compared with the oracle' } },
  partial: Boolean(filter) || minPass === null,
  run: main,
})
