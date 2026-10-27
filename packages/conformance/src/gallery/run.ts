/**
 * `pnpm conformance:gallery` - the OFFICIAL Vega and Vega-Lite example galleries (vendored in ../../gallery at the versions the
 * oracle is pinned to) against real vega, through both paths a user takes:
 *
 *   static  real vega vs `renderSpec` (+ @aster/vl for Vega-Lite), canonical SVG compared exactly, in Node
 *   react   real vega vs <Chart> mounted as an app would (loadSpecData, add-ons, no size props unless the spec has numeric ones),
 *           in headless Chromium
 *
 * Every outcome is one of pass / fail / error / unverifiable. `unverifiable` is the only non-failure that is not a pass: the
 * ORACLE is not a function of its inputs (random(), timers) or fails itself, so there is nothing to compare against; each one
 * is listed with its reason and counted against a ceiling. A diff is never tolerated: every fail and error is printed with its
 * first diff.
 *
 * The galleries are fetched, not committed (`pnpm --filter @aster/conformance gallery:fetch`, see gallery/README.md); the gate reads
 * only the local cache and fails, naming that command, when it is missing or does not match gallery/manifest.json.
 * The gate is a ratchet (gallery/floors.json, gallery/passing-<path>.txt):
 *   - the spec counts must equal the manifest (specs cannot be dropped to improve the numbers);
 *   - passing count >= floor, per path and grammar; unverifiable <= ceiling;
 *   - every spec listed in passing-<path>.txt must still pass (a count floor alone lets one fix hide one regression).
 * When the numbers improve it says so: raise the floors and add the names (`--print-passing`), never lower them.
 *
 * Usage: tsx src/gallery/run.ts [--path=static|react|all] [--filter=substr] [--json=file] [--print-passing]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FETCH_COMMAND, readManifest, verifyCache } from './cache.js'
import { GALLERY_DIR, listGallery, type GallerySpec, type Kind, type Outcome } from './lib.js'

const argv = process.argv.slice(2)
const arg = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const PATHS = (arg('path') ?? 'all') === 'all' ? (['static', 'react'] as const) : ([arg('path')] as ('static' | 'react')[])
const FILTER = arg('filter')
const JSON_OUT = arg('json')
const PRINT_PASSING = argv.includes('--print-passing')

interface Floors {
  pass: Record<'static' | 'react', Record<Kind, number>>
  maxUnverifiable: Record<'static' | 'react', Record<Kind, number>>
}
const floors = JSON.parse(readFileSync(join(GALLERY_DIR, 'floors.json'), 'utf8')) as Floors
const passingList = (p: string): string[] => readFileSync(join(GALLERY_DIR, `passing-${p}.txt`), 'utf8').split('\n').filter(Boolean)

// The gate reads the local cache only. A missing or altered cache is a failure with the command that fixes it, never a skip.
const manifest = readManifest()
const cacheProblems = verifyCache(manifest)
if (cacheProblems.length) {
  console.error(`GATE FAIL: the gallery cache (packages/conformance/.gallery) is missing or does not match gallery/manifest.json:\n  ${cacheProblems.slice(0, 8).join('\n  ')}${cacheProblems.length > 8 ? `\n  ... ${cacheProblems.length} problems` : ''}\nRun: ${FETCH_COMMAND}`)
  process.exit(1)
}
const all = listGallery()
const specs: GallerySpec[] = FILTER ? all.filter((g) => g.id.includes(FILTER)) : all
let problems = 0
const problem = (m: string): void => { problems++; console.log(`GATE FAIL: ${m}`) }

if (!FILTER) {
  // the manifest lists every spec: a spec cannot drop out of the denominator without a visible manifest change
  for (const [k, src] of [['vega', 'vega'], ['vl', 'vega-lite']] as const) {
    const n = all.filter((g) => g.kind === k).length
    const m = Object.keys(manifest.sources[src]!.files).length
    if (n !== m) problem(`${k}: ${n} specs read, the manifest lists ${m}`)
  }
}
if (!specs.length) { console.log('GATE FAIL: no specs selected'); process.exit(1) }

const t0 = Date.now()
const results: Record<string, Outcome[]> = {}
const runPath = async (p: 'static' | 'react'): Promise<void> => {
  if (p === 'static') {
    const { runStatic } = await import('./static.js')
    const out: Outcome[] = []
    for (const g of specs) out.push(await runStatic(g))
    results.static = out
  } else {
    const { runReact } = await import('./react.js')
    results.react = await runReact(specs, () => undefined, 4)
  }
}
await Promise.all(PATHS.map(runPath))

const kindOf = (id: string): Kind => (id.startsWith('vega/') ? 'vega' : 'vl')
const dump: Record<string, Outcome[]> = {}
for (const p of PATHS) {
  const out = results[p]!
  dump[p] = out
  console.log(`\n=== ${p} path ===`)
  for (const k of ['vega', 'vl'] as const) {
    const mine = out.filter((o) => kindOf(o.id) === k)
    const n = (s: string): number => mine.filter((o) => o.status === s).length
    const pass = n('pass')
    console.log(`${k === 'vega' ? 'Vega     ' : 'Vega-Lite'} ${pass} pass, ${n('fail')} fail, ${n('error')} error, ${n('unverifiable')} unverifiable / ${mine.length}`)
    if (!FILTER) {
      if (pass < floors.pass[p][k]) problem(`${p}/${k}: ${pass} passing < floor ${floors.pass[p][k]}`)
      else if (pass > floors.pass[p][k]) console.log(`  (improved: ${pass} > floor ${floors.pass[p][k]}; raise floors.json and add the names to passing-${p}.txt)`)
      if (n('unverifiable') > floors.maxUnverifiable[p][k]) problem(`${p}/${k}: ${n('unverifiable')} unverifiable > ceiling ${floors.maxUnverifiable[p][k]}`)
    }
  }
  const unv = out.filter((o) => o.status === 'unverifiable')
  if (unv.length) {
    console.log(`-- unverifiable on the ${p} path (the oracle itself is not comparable; NOT counted as passing):`)
    for (const o of unv) console.log(`  UNVERIFIABLE ${o.id}: ${o.reason}${o.first ? ` | ${o.first}` : ''}`)
  }
  const bad = out.filter((o) => o.status === 'fail' || o.status === 'error')
  console.log(`-- failing on the ${p} path (${bad.length}), first diff each:`)
  for (const o of bad) console.log(`  ${o.status.toUpperCase().padEnd(5)} ${o.id}: ${o.reason ? `[${o.reason}] ` : ''}${o.first ?? ''}${o.firstContent && o.firstContent !== o.first ? `\n        -> ${o.firstContent}` : ''}`)
  if (!FILTER) {
    const passed = new Set(out.filter((o) => o.status === 'pass').map((o) => o.id))
    const regressed = passingList(p).filter((id) => !passed.has(id))
    if (regressed.length) problem(`${p}: ${regressed.length} spec(s) that passed at the recorded baseline no longer do: ${regressed.join(', ')}`)
    if (PRINT_PASSING) writeFileSync(join(GALLERY_DIR, `passing-${p}.txt`), [...passed].sort().join('\n') + '\n')
  }
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(dump, null, 1))
console.log(`\n[gallery] ${specs.length} specs, ${((Date.now() - t0) / 1000).toFixed(0)}s, ${problems ? `${problems} gate failure(s)` : 'ratchet holds'}`)
process.exit(problems ? 1 : 0)
