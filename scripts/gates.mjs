#!/usr/bin/env node
/**
 * The gate list: the single source of truth for "what must be green".
 *
 * `pnpm check` runs this; CI (.github/workflows/ci.yml) runs `pnpm check`;
 * CONTRIBUTING.md and docs/TESTING.md point here instead of copying the list.
 * To add, remove or reorder a gate, edit GATES below and nothing else
 * (scripts/gates.test.mjs fails if a gate names a script that does not exist or
 * if a workflow runs a gate outside this list).
 *
 * Usage:
 *   pnpm check                          run every gate, report all failures
 *   pnpm check -- --list                print the gates and exit
 *   pnpm check -- --only conformance,a11y-parity
 *   pnpm check -- --skip browser        skip gates tagged `browser` (needs no Chromium)
 *   pnpm check -- --fail-fast           stop at the first failure
 *
 * Browser gates need Playwright Chromium:
 *   pnpm --filter @aster/conformance exec playwright install --with-deps chromium
 * Skipping them locally is allowed; CI never skips anything.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** @type {{ name: string, args: string[], tags?: string[], blocking?: boolean, why: string }[]} */
export const GATES = [
  { name: 'build', args: ['build'], why: 'every package compiles to dist' },
  { name: 'deps', args: ['check:deps'], why: 'runtime and built dist import none of vega/d3/topojson' },
  { name: 'typecheck', args: ['typecheck'], why: 'all workspaces typecheck' },
  { name: 'test', args: ['test'], why: 'unit, React interaction/SSR/a11y, script tests; the React component tests run on <Chart>, <SvgChart> and <SvgChart interaction> (variant matrix), with the thin-shell, matrix-coverage, type-parity and 785-spec output-parity guards' },
  { name: 'tz-matrix', args: ['test:tz'], why: 'zone-sensitive tests and the time-zone corpus under non-UTC zones (UTC labels, local time scales)' },
  { name: 'verify-publish', args: ['verify:publish'], why: 'packed tarballs: licences, exports, consumer smoke test' },
  {
    name: 'incremental-append', args: ['bench:incremental', '--', '--points=10000', '--reps=30'],
    why: 'incremental append, whole-array replace and DOM patch beat their baselines by the measured floors (8x, 8x, 1.6x), not just by >1x',
  },
  { name: 'conformance', args: ['conformance'], why: 'Vega corpus: SVG diff against the real Vega oracle' },
  { name: 'conformance-vl', args: ['conformance-vl'], why: '@aster/vl compile + render against the Vega-Lite oracle' },
  { name: 'scene-diff', args: ['scene-diff'], why: 'resolved scales/groups/items per scope' },
  { name: 'a11y-parity', args: ['a11y-parity'], why: 'guide captions vs vega-scenegraph aria-label' },
  { name: 'transform-matrix', args: ['transform-matrix'], why: 'transform option combinations vs the oracle' },
  { name: 'canvas', args: ['conformance:canvas'], tags: ['browser'], why: 'Chromium canvas pixel parity' },
  { name: 'batch', args: ['conformance:batch'], tags: ['browser'], why: 'batched-SVG pixel parity (denseMarks vs per-item)' },
  {
    name: 'signals-browser', args: ['conformance:signals'], tags: ['browser'],
    why: 'signal event streams (selectors, between, filters, throttle, consume, native event) vs real vega in Chromium',
  },
  {
    name: 'react-browser', args: ['--filter', '@aster/react', 'run', 'test:browser'], tags: ['browser'],
    why: '<Chart> and <SvgChart interaction> pointer/keyboard interaction, selection, pan/zoom, signal.on, bound inputs and the a11y overlay in a real Chromium; <SvgChart> without interaction renders and reports the missing event loop',
  },
  {
    name: 'browser-conformance', args: ['conformance:browser'], tags: ['browser'],
    why: 'the corpus rendered by vega (string renderer) and Aster in Chromium with live canvas text metrics',
  },
  {
    // The floors are today's numbers and only ratchet. `retained` counts the cases where vega's own second render
    // differs from its fresh render of the same signals (autosize runs once, a half-failed dataflow keeps its old
    // tick items...): the engine is a pure function of its inputs, so it renders the fresh one.
    name: 'sweep-signals',
    args: ['sweep-signals', '--', '--floor', '166', '--min-ok', '104', '--max-node-error', '2', '--max-retained', '59'],
    why: 'a signal written into a running chart renders like vega (signals sweep)',
  },
  { name: 'fuzz-replay', args: ['fuzz:replay'], why: 'every committed fuzz reproducer still passes' },
  {
    name: 'bundle-shaking', args: ['check:bundle'],
    why: 'each documented import pattern is bundled (esbuild, production, tree-shaking) and EXECUTED: sideEffects must not shake out a registration (VL, geo, transforms, load, guide captions, worker entry); <SvgChart> bundles contain no canvas/hit/signals module unless asked (esbuild metafile)',
  },
  { name: 'budget', args: ['--filter', '@aster/benchmarks', 'run', 'budget'], why: 'per-import-pattern bundle size budgets (useChart, <Chart>, <SvgChart>, <SvgChart>+interaction, <Chart>+VL, core, addons as marginal cost); fails if tree-shaking breaks' },
  { name: 'probe', args: ['probe'], blocking: false, why: 'known-gap probes (diagnostic only; never fails the run)' },
]

function csv(argv, flag) {
  const i = argv.indexOf(flag)
  if (i < 0) return null
  const v = argv[i + 1]
  if (!v || v.startsWith('--')) {
    console.error(`[gates] ${flag} needs a comma-separated value`)
    process.exit(2)
  }
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--list')) {
    for (const g of GATES) {
      const tags = [...(g.tags ?? []), ...(g.blocking === false ? ['non-blocking'] : [])]
      console.log(`${g.name.padEnd(18)} pnpm ${g.args.join(' ').padEnd(54)} ${g.why}${tags.length ? `  [${tags.join(',')}]` : ''}`)
    }
    return
  }
  const only = csv(argv, '--only')
  const skip = csv(argv, '--skip') ?? []
  const failFast = argv.includes('--fail-fast')
  const known = new Set(GATES.flatMap((g) => [g.name, ...(g.tags ?? [])]))
  for (const n of [...(only ?? []), ...skip]) {
    if (!known.has(n)) {
      console.error(`[gates] unknown gate or tag "${n}"; try --list`)
      process.exit(2)
    }
  }

  const selected = GATES.filter((g) => {
    if (only && !only.includes(g.name)) return false
    return !(skip.includes(g.name) || (g.tags ?? []).some((t) => skip.includes(t)))
  })
  if (selected.length === 0) {
    console.error('[gates] no gates selected')
    process.exit(2)
  }

  const inCI = process.env.GITHUB_ACTIONS === 'true'
  const results = []
  for (const g of selected) {
    const t0 = Date.now()
    if (inCI) console.log(`::group::${g.name}`)
    console.log(`\n[gates] ${g.name}: pnpm ${g.args.join(' ')}`)
    const r = spawnSync('pnpm', g.args, { stdio: 'inherit' })
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    const ok = r.status === 0
    if (inCI) console.log('::endgroup::')
    results.push({ name: g.name, ok, blocking: g.blocking !== false, secs })
    if (!ok && inCI) console.log(`::${g.blocking === false ? 'warning' : 'error'}::gate ${g.name} failed`)
    if (!ok && g.blocking !== false && failFast) break
  }

  console.log('\n[gates] summary')
  for (const r of results) {
    const tag = r.ok ? 'PASS' : r.blocking ? 'FAIL' : 'WARN'
    console.log(`  ${tag}  ${r.name.padEnd(18)} ${r.secs}s`)
  }
  const failed = results.filter((r) => !r.ok && r.blocking)
  if (selected.length < GATES.length) {
    console.log(`[gates] NOTE: ${GATES.length - selected.length} gate(s) not run; this is not the full CI list`)
  }
  if (failed.length) {
    console.error(`[gates] ${failed.length} blocking gate(s) failed: ${failed.map((r) => r.name).join(', ')}`)
    process.exit(1)
  }
  console.log('[gates] all selected gates passed')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
