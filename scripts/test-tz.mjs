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
 *
 * A zone name is checked before anything runs: Node treats an unknown `TZ` as UTC, so `pnpm test:tz Asia/Kolkatta` used to run in UTC and
 * report "all zones passed". Exit codes: 0 every zone passed, 1 a result differs from vega, 2 bad usage (an unknown option or an unknown zone).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cli } from './lib/cli.mjs'
import { ZONES } from './lib/tz-zones.mjs'


/** The corpus also runs in UTC (the default test run does not cover it). */
const CORPUS_ZONES = ['UTC', ...ZONES]
const UNIT_FILTERS = ['.tz.test.', 'differential-scale-spec']

function run(label, cmd, args, env) {
  console.log(`\n[tz] ${label}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  return r.status === 0
}

/** Whether ICU knows `tz` (an IANA name or alias, `UTC`): the set Node's `TZ` accepts, which silently falls back to UTC for anything else. */
export function isKnownZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return typeof tz === 'string' && tz !== ''
  } catch {
    return false
  }
}

function main() {
  cli({ url: import.meta.url, args: '[zone ...]' })
  const zones = process.argv.slice(2).filter((a) => a !== '--')
  const unknown = zones.filter((z) => !isKnownZone(z))
  if (unknown.length) {
    console.error(`[tz] unknown time zone${unknown.length > 1 ? 's' : ''}: ${unknown.map((z) => JSON.stringify(z)).join(', ')} (an IANA name such as Asia/Kolkata; Node would run an unknown TZ as UTC)`)
    process.exit(2)
  }
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
