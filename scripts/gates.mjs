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
 *   pnpm check -- --only conformance,a11y-parity   (names or tags, e.g. --only browser)
 *   pnpm check -- --skip browser        skip gates tagged `browser` (needs no Chromium)
 *   pnpm check -- --fail-fast           stop at the first failure
 *   pnpm check -- --help                print this text
 *
 * Each gate has a deadline (`timeoutMs`, else DEFAULT_TIMEOUT_MS): a gate that exceeds it is killed with its process tree, reported as
 * `FAIL <gate> (timeout)`, and the run goes on. `--only` and `--skip` both take gate names and tags.
 *
 * Exit codes: 0 every selected gate passed (or --list/--help), 1 a blocking gate failed or timed out, 2 bad usage (an unknown option or gate name), 130 interrupted.
 *
 * Every gate says how its exit status is earned (`verdict`), and scripts/gate-self-test.test.mjs holds each one to it:
 *   - `selfTest`: the gate's script reports to runGate (scripts/lib/run-gate.mjs). The test runs it narrowed (`narrow`: it
 *     must pass), narrowed with --plant-difference (it must fail with DIFFERS) and narrowed to nothing (`none`: it must fail
 *     with FLOOR); a gate script that sets its own exit code is refused.
 *   - `proof`: the gate is a tool with an exit status of its own (tsc, knip, vitest), or a script whose failure paths the test
 *     file named here exercises.
 *   - `exits`: a measuring script (a benchmark floor, the bundle budget, the zone matrix of other gates' runs) with no planted
 *     self-test: the test only requires that the script named here has a failing exit path (`process.exit(1)` or
 *     `process.exitCode = 1`).
 *
 * Browser gates need Playwright Chromium:
 *   pnpm --filter @aster-charts/conformance exec playwright install --with-deps chromium
 * Skipping them locally is allowed; CI never skips anything.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cli } from './lib/cli.mjs'

/**
 * Every gate has a deadline (a Playwright page that never settles must not hold a run, or CI's six-hour default, hostage): the
 * gate's own `timeoutMs`, else this one. A gate that runs out of time is killed with its whole process tree and reported as
 * `FAIL <gate> (timeout)`; the other gates still run. Generous on purpose: a deadline is for a gate that hangs, not one that is slow on a loaded
 * machine (the whole list has to fit the 90 minutes of the `ci` job; the nightly allows 90 for it plus the sweeps).
 */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000

/**
 * @typedef {{ args?: string[], env?: Record<string, string> }} Run
 * @typedef {{ selfTest: { narrow: Run, none: Run | null, noneWhy?: string } } | { proof: string } | { exits: string }} Verdict
 * @type {{ name: string, args: string[], tags?: string[], blocking?: boolean, timeoutMs?: number, command?: string, why: string, verdict: Verdict }[]}
 */
export const GATES = [
  { name: 'build', args: ['build'], why: 'every package compiles to dist', verdict: { proof: 'tsc (each package\'s build) exits non-zero on an error' } },
  { name: 'deps', args: ['check:deps'], why: 'runtime and built dist import none of vega/d3/topojson', verdict: { proof: 'scripts/check-deps.test.mjs' } },
  { name: 'knip', args: ['knip'], why: 'no unused files, exports or dependencies in the published packages, their tests and the conformance suite (knip.json)', verdict: { proof: 'knip exits non-zero on a finding' } },
  { name: 'typecheck', args: ['typecheck'], why: 'all workspaces typecheck', verdict: { proof: 'tsc --noEmit exits non-zero on an error' } },
  { name: 'test', args: ['test'], timeoutMs: 60 * 60_000, why: 'unit, React interaction/SSR/a11y, script tests; the React component tests run on <Chart>, <SvgChart> and <SvgChart interaction> (variant matrix), with the thin-shell, matrix-coverage, type-parity and corpus-wide output-parity guards', verdict: { proof: 'vitest exits non-zero on a failing test' } },
  { name: 'tz-matrix', args: ['test:tz'], why: 'zone-sensitive tests and the time-zone corpus under non-UTC zones (UTC labels, local time scales)', verdict: { exits: 'scripts/test-tz.mjs' } },
  { name: 'verify-publish', args: ['verify:publish'], why: 'packed tarballs: licences, exports, consumer smoke test', verdict: { proof: 'scripts/verify-publish.test.mjs' } },
  {
    name: 'incremental-append', args: ['bench:incremental', '--', '--points=10000', '--reps=30'],
    why: 'incremental append, whole-array replace and DOM patch beat their baselines by the measured floors (8x, 8x, 1.6x), not just by >1x',
    verdict: { exits: 'packages/benchmarks/src/incremental.bench.tsx' },
  },
  { name: 'conformance', args: ['conformance'], why: 'Vega corpus: SVG diff against the real Vega oracle', verdict: { selfTest: { narrow: { env: { ASTER_CORPUS_FILTER: '^arc-pie$' } }, none: { env: { ASTER_CORPUS_FILTER: '^no-such-entry$' } } } } },
  { name: 'conformance-vl', args: ['conformance-vl'], why: '@aster-charts/vl compile + render against the Vega-Lite oracle', verdict: { selfTest: { narrow: { args: ['arc-pie'] }, none: { args: ['no-such-entry'] } } } },
  { name: 'scene-diff', args: ['scene-diff'], why: 'resolved scales/groups/items per scope', verdict: { selfTest: { narrow: { args: ['--filter', 'arc-pie'] }, none: { args: ['--filter', 'no-such-entry'] } } } },
  {
    name: 'incremental-diff', args: ['conformance:diff'],
    why: 'every inline-data corpus spec: a random per-datum changeset (dataChanges) over the built chart renders the same SVG as a fresh evaluation of the new data (reads dist, so it runs after build)',
    verdict: { selfTest: { narrow: { args: ['--filter=arc-pie'] }, none: { args: ['--filter=no-such-entry'] } } },
  },
  { name: 'a11y-parity', args: ['a11y-parity'], why: 'guide captions vs vega-scenegraph aria-label', verdict: { selfTest: { narrow: { args: ['--filter', 'arc-pie'] }, none: { args: ['--filter', 'no-such-entry'] } } } },
  { name: 'transform-matrix', args: ['transform-matrix'], why: 'transform option combinations vs the oracle', verdict: { selfTest: { narrow: { args: ['--filter', 'fold'] }, none: { args: ['--filter', 'no-such-case'] } } } },
  { name: 'canvas', args: ['conformance:canvas'], tags: ['browser'], why: 'Chromium canvas pixel parity', verdict: { selfTest: { narrow: { args: ['--filter=arc-pie'] }, none: { args: ['--filter=no-such-entry'] } } } },
  { name: 'batch', args: ['conformance:batch'], tags: ['browser'], why: 'batched-SVG pixel parity (denseMarks vs per-item)', verdict: { selfTest: { narrow: { args: ['--filter=batch-512'] }, none: { args: ['--filter=no-such-entry'] } } } },
  {
    name: 'signals-browser', args: ['conformance:signals'], tags: ['browser'],
    why: 'signal event streams (selectors, between, filters, throttle, consume, native event, the item an event is about) vs real vega in Chromium, on its svg and its canvas renderer',
    verdict: { selfTest: { narrow: { args: ['--filter=plain-click-counts-only-clicks'] }, none: { args: ['--filter=no-such-case'] } } },
  },
  {
    name: 'selections-browser', args: ['conformance:selections'], tags: ['browser'],
    why: 'Vega-Lite selections: the same native input (click, shift-click, drag, wheel, legend click, bound inputs, nearest, bound scales) through vega-lite + real vega and through @aster-charts/vl + <Chart>, on the svg and the canvas renderer; signals, selection stores and SVG (or canvas pixels) compared after every step',
    verdict: { selfTest: { narrow: { args: ['--filter=point toggle: false'] }, none: { args: ['--filter=no-such-case'] } } },
  },
  {
    name: 'intersect-browser', args: ['conformance:intersect'], tags: ['browser'],
    why: 'the intersect() expression function (vega-lite geo interval selections) over every mark type, boxes and filters vs real vega in Chromium (arc and path outlines need a canvas context), directly and through the event loop on each renderer',
    verdict: { selfTest: { narrow: { args: ['--filter=m_rect2'] }, none: { args: ['--filter=no-such-scope'] } } },
  },
  {
    name: 'geometry-browser', args: ['conformance:geometry'], tags: ['browser'],
    why: 'generated geometry specs (every mark type, nested groups, the value classes no scale writes): the pick on each renderer and intersect() vs real vega in Chromium, under a deadline; the differences that remain are named by what the oracle does there (src/geometry-differences.ts) and must still differ',
  },
  {
    name: 'react-browser', args: ['--filter', '@aster-charts/react', 'run', 'test:browser'], tags: ['browser'],
    why: '<Chart> (svg and canvas) and <SvgChart interaction> pointer/keyboard interaction, selection, pan/zoom, signal.on, bound inputs and the a11y overlay in a real Chromium; <SvgChart> without interaction renders and reports the missing event loop; a `transition` draws real frames and settles on the exact final svg',
    verdict: { selfTest: { narrow: {}, none: null, noneWhy: 'its checks are unconditional statements of one script, not cases a filter selects: a run with no check is not reachable' } },
  },
  {
    name: 'browser-conformance', args: ['conformance:browser'], tags: ['browser'],
    why: 'the corpus rendered by vega (string renderer) and Aster in Chromium with live canvas text metrics',
    verdict: { selfTest: { narrow: { args: ['--filter=arc-pie'] }, none: { args: ['--filter=no-such-entry'] } } },
  },
  {
    // The floors are today's numbers and only ratchet. `retained` counts the cases where vega's own second render
    // differs from its fresh render of the same signals (autosize runs once, a half-failed dataflow keeps its old
    // tick items...): the engine is a pure function of its inputs, so it renders the fresh one.
    // One case moved from ok to retained (104 -> 103 / 59 -> 60) when symbol bounds became exact: a-mark-shape--M0-0L8-8Z writes a custom
    // path shape, whose real extent now sizes the fresh view as vega's does, while vega's second render keeps the first shape's size.
    name: 'sweep-signals',
    args: ['sweep-signals', '--', '--floor', '166', '--min-ok', '103', '--max-node-error', '2', '--max-retained', '60'],
    why: 'a signal written into a running chart renders like vega (signals sweep)',
    verdict: { proof: 'packages/conformance/scripts/run-sweep.test.mjs' },
  },
  { name: 'fuzz-replay', args: ['fuzz:replay'], why: 'every committed fuzz reproducer still passes', verdict: { selfTest: { narrow: {}, none: { args: ['--repro-dir=<empty>'] } } } },
  {
    name: 'bundle-shaking', args: ['check:bundle'],
    why: 'each documented import pattern is bundled (esbuild, production, tree-shaking) and EXECUTED: sideEffects must not shake out a registration (VL, geo, transforms, load, guide captions, worker entry); <SvgChart> bundles contain no canvas/hit/signals module unless asked (esbuild metafile)',
    verdict: { proof: 'scripts/bundle-shaking.test.mjs' },
  },
  { name: 'budget', args: ['--filter', '@aster-charts/benchmarks', 'run', 'budget'], why: 'per-import-pattern bundle size budgets (useChart, <Chart>, <SvgChart>, <SvgChart>+interaction, <Chart>+VL, core, addons as marginal cost); fails if tree-shaking breaks', verdict: { exits: 'packages/benchmarks/scripts/budget.mjs' } },
  {
    // The floor is the number of probes compared today (probes/ holds 2). A failing probe documents a gap only when it is listed in
    // scripts/lib/expected-differences.mjs, which requires it to keep failing; an empty probes/ is not a pass either.
    name: 'probe', args: ['probe', '--', '--min-pass', '2'],
    why: 'known-gap probes: each passes, or is a listed gap that still fails',
    verdict: { selfTest: { narrow: { args: ['t-geopoint'] }, none: { args: ['no-such-probe'] } } },
  },
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

/** The deadline of a gate in milliseconds. */
export const timeoutOf = (g) => g.timeoutMs ?? DEFAULT_TIMEOUT_MS

/** How long a gate gets to exit after SIGTERM before its whole process group is killed outright. */
const KILL_GRACE_MS = 5_000

/**
 * Run one gate to completion or to its deadline. The gate runs in its own process group so the deadline (and an interrupt of this
 * runner) reaches pnpm's children too: Chromium, vitest workers.
 * @returns {Promise<{ ok: boolean, status: number | null, timedOut: boolean, interrupted?: boolean }>}
 */
export function runGate(g, { stdio = 'inherit', env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(g.command ?? 'pnpm', g.args, { stdio, env, detached: true })
    let timedOut = false
    let interrupted = false
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal) } catch { /* the group is already gone */ }
    }
    const onSignal = (signal) => { interrupted = true; killGroup(signal) }
    const forward = ['SIGINT', 'SIGTERM']
    for (const sig of forward) process.on(sig, onSignal)
    let hardKill
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      hardKill = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
    }, timeoutOf(g))
    const done = (status) => {
      clearTimeout(timer)
      clearTimeout(hardKill)
      for (const sig of forward) process.off(sig, onSignal)
      // Whatever the gate left behind in its group (a browser the gate did not close) goes with it.
      killGroup('SIGKILL')
      resolve({ ok: status === 0 && !timedOut && !interrupted, status, timedOut, interrupted })
    }
    child.on('error', () => done(null))
    child.on('close', (status) => done(status))
  })
}

/**
 * Run `selected` in order and print the summary. Returns the exit code: 0 all passed, 1 a blocking gate failed or timed out.
 * @param {typeof GATES} selected
 */
export async function runGates(selected, { failFast = false, total = selected.length, inCI = false, run = runGate } = {}) {
  const results = []
  for (const g of selected) {
    const t0 = Date.now()
    if (inCI) console.log(`::group::${g.name}`)
    console.log(`\n[gates] ${g.name}: pnpm ${g.args.join(' ')}  (deadline ${Math.round(timeoutOf(g) / 60_000)} min)`)
    const r = await run(g)
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    if (inCI) console.log('::endgroup::')
    results.push({ name: g.name, ok: r.ok, timedOut: r.timedOut, blocking: g.blocking !== false, secs })
    if (r.timedOut) console.error(`[gates] ${g.name} exceeded its deadline of ${timeoutOf(g) / 1000} s and was killed`)
    if (!r.ok && inCI) console.log(`::${g.blocking === false ? 'warning' : 'error'}::gate ${g.name} failed${r.timedOut ? ' (timeout)' : ''}`)
    if (r.interrupted) { console.error('[gates] interrupted'); return 130 }
    if (!r.ok && g.blocking !== false && failFast) break
  }

  console.log('\n[gates] summary')
  for (const r of results) {
    const tag = r.ok ? 'PASS' : r.blocking ? 'FAIL' : 'WARN'
    console.log(`  ${tag}  ${r.name.padEnd(18)} ${r.secs}s${r.timedOut ? ' (timeout)' : ''}`)
  }
  const failed = results.filter((r) => !r.ok && r.blocking)
  if (selected.length < total) {
    console.log(`[gates] NOTE: ${total - selected.length} gate(s) not run; this is not the full CI list`)
  }
  if (failed.length) {
    console.error(`[gates] ${failed.length} blocking gate(s) failed: ${failed.map((r) => r.name + (r.timedOut ? ' (timeout)' : '')).join(', ')}`)
    return 1
  }
  console.log('[gates] all selected gates passed')
  return 0
}

/** `--only` and `--skip` both take gate names and tags (`--only browser` is every gate tagged `browser`). */
export function selectGates(gates, only, skip = []) {
  const matches = (g, list) => list.includes(g.name) || (g.tags ?? []).some((t) => list.includes(t))
  return gates.filter((g) => (!only || matches(g, only)) && !matches(g, skip))
}

async function main() {
  cli({ url: import.meta.url, flags: { list: 'bool', only: 'value', skip: 'value', 'fail-fast': 'bool' } })
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
  const names = new Set(GATES.map((g) => g.name))
  const tags = new Set(GATES.flatMap((g) => g.tags ?? []))
  for (const n of [...(only ?? []), ...skip]) {
    if (!names.has(n) && !tags.has(n)) {
      console.error(`[gates] unknown gate or tag "${n}"; try --list`)
      process.exit(2)
    }
  }

  const selected = selectGates(GATES, only, skip)
  if (selected.length === 0) {
    console.error('[gates] no gates selected')
    process.exit(2)
  }

  process.exitCode = await runGates(selected, { failFast, total: GATES.length, inCI: process.env.GITHUB_ACTIONS === 'true' })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
