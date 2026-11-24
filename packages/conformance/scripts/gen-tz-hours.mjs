/**
 * Records what real vega (the pinned 6.3.1) draws for a time scale over [0, 6 h] in each zone `pnpm test:tz` runs under, plus UTC:
 * the `LOCAL_HOURS` table of packages/core/src/calendar.tz.test.ts. Paste the printed object over it. Run:
 *
 *   node packages/conformance/scripts/gen-tz-hours.mjs
 *
 * Each zone is recorded in a child process started with that TZ (a zone is read once, when the process starts).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cli } from '../../../scripts/lib/cli.mjs'
import { ZONES } from '../../../scripts/lib/tz-zones.mjs'

cli({ url: import.meta.url, flags: { zone: 'value' } })

const H = 3600000
const zoneFlag = process.argv.indexOf('--zone')

if (zoneFlag >= 0) {
  // the child: one zone, TZ already set by the parent
  const vega = await import('vega')
  const spec = {
    width: 400, height: 100, padding: 5, autosize: 'none',
    scales: [{ name: 'x', type: 'time', range: 'width', domain: [0, 6 * H] }],
    axes: [{ scale: 'x', orient: 'bottom' }],
  }
  const svg = await new vega.View(vega.parse(spec), { renderer: 'none' }).toSVG()
  console.log(JSON.stringify([...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])))
} else {
  const out = {}
  for (const zone of ['UTC', ...ZONES]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--zone', zone], { env: { ...process.env, TZ: zone }, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`recording ${zone} failed: ${r.stderr}`)
    out[zone] = JSON.parse(r.stdout)
  }
  console.log(JSON.stringify(out, null, 2))
}
