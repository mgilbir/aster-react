/**
 * Feature-gap probe runner. Same oracle diff as the conformance run, but pointed
 * at `probes/` — specs that exercise feature areas the corpus doesn't cover yet.
 * A probe that fails documents a gap and is allowed; a probe that PASSED and stops passing is not: `--min-pass N` is the
 * floor on the number that pass (probe-verdict.ts), and the gate (scripts/gates.mjs) runs with the number passing today.
 * When a gap is implemented, the probe is promoted to `corpus/`.
 *
 * Usage: pnpm probe [name-filter] [--min-pass N]
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
import { parseProbeArgs, probeVerdict } from './probe-verdict.js'

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

async function runOne(entry: ProbeEntry) {
  try {
    const spec = entry.kind === 'vg' ? entry.spec : (vl.compile(entry.spec as any).spec as unknown as Record<string, unknown>)
    const [oracleSvg, ourSvg] = await Promise.all([
      renderWithVega(spec),
      // url datasets resolve through the load addon, exactly what a real host does
      loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS).then((loaded) => renderSpec(loaded as never)),
    ])
    const diffs = diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(ourSvg))
    return { pass: diffs.length === 0, diffs }
  } catch (err) {
    return { pass: false, diffs: [], error: err instanceof Error ? err.message : String(err) }
  }
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'probes')
if (!existsSync(dir)) {
  console.error(`[probe] probes directory not found: ${dir}`)
  process.exit(1)
}
const { filter, minPass } = parseProbeArgs(process.argv.slice(2))
const entries = loadProbes(dir).filter((e) => !filter || e.name.includes(filter))

const results: Array<{ name: string; pass: boolean; note: string }> = []
for (const entry of entries) {
  const r = await runOne(entry)
  let note = ''
  if (!r.pass) {
    if (r.error) note = r.error.split('\n')[0]!.slice(0, 120)
    else note = r.diffs[0]?.slice(0, 120) ?? ''
  }
  results.push({ name: entry.name, pass: r.pass, note })
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${entry.name}${note ? `  — ${note}` : ''}`)
  if (!r.pass && !r.error) for (const d of r.diffs.slice(1, 4)) console.log(`      ${d}`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n[probe] ${results.length - failed.length}/${results.length} passed`)
if (failed.length) console.log(`[probe] gaps: ${failed.map((f) => f.name).join(', ')}`)
const verdict = probeVerdict(results.length - failed.length, results.length, minPass)
console.log(`[probe] ${verdict.ok ? 'ok' : 'FAIL'}: ${verdict.reason}`)
if (!verdict.ok) process.exitCode = 1
