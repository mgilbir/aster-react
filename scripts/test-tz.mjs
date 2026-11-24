#!/usr/bin/env node
/**
 * Time-zone matrix: the zone-sensitive tests, run under zones other than UTC.
 *
 * The whole repo used to run under TZ=UTC (the oracle vectors even pin it), which
 * hid every bug where a UTC scale formatted its labels in the viewer's local zone.
 * This runs, per zone:
 *
 *   - the zone-aware unit tests (`*.tz.test.ts`) and the live scale-spec differential
 *     against real Vega (vega runs in the same process and zone; UTC and numeric scales must not move)
 *   - the time-zone corpus (`packages/conformance/corpus-tz`): raw Vega specs rendered
 *     by real vega and by Aster in that same zone, SVG diffed
 *
 * `pnpm check` runs it as the `tz-matrix` gate. Usage: node scripts/test-tz.mjs [zone ...]
 * (zones are IANA names such as Asia/Kolkata; with none given it runs the three above, plus UTC for the corpus).
 */
import { spawnSync } from 'node:child_process'
import { cli } from './lib/cli.mjs'
import { ZONES } from './lib/tz-zones.mjs'

cli({ url: import.meta.url, args: '[zone ...]' })

/** The corpus also runs in UTC (the default test run does not cover it). */
const CORPUS_ZONES = ['UTC', ...ZONES]
const UNIT_FILTERS = ['.tz.test.', 'differential-scale-spec']

function run(label, cmd, args, env) {
  console.log(`\n[tz] ${label}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  return r.status === 0
}

const zones = process.argv.slice(2)
let ok = true
for (const tz of zones.length ? zones : ZONES) {
  ok = run(`vitest under TZ=${tz}`, 'pnpm', ['exec', 'vitest', 'run', ...UNIT_FILTERS], { TZ: tz }) && ok
}
for (const tz of zones.length ? zones : CORPUS_ZONES) {
  ok = run(
    `corpus-tz under TZ=${tz}`,
    'pnpm', ['--filter', '@aster-charts/conformance', 'exec', 'tsx', 'src/run.ts'],
    { TZ: tz, ASTER_CORPUS_DIR: 'corpus-tz' },
  ) && ok
}
if (!ok) {
  console.error('\n[tz] FAILED: a zone-dependent result differs from vega')
  process.exit(1)
}
console.log('\n[tz] all zones passed')
