/**
 * Differential fuzzer.
 *
 * Generates deterministic Vega specs from a seeded PRNG, renders each through
 * the real Vega oracle and through @aster-charts/core, canonicalizes both SVGs and
 * compares geometry. Any mismatch is written to `fuzz-repro/` as a standalone
 * spec. The nightly job uploads those files as a workflow artifact (it commits
 * nothing); a reproducer becomes part of `fuzz:replay` only when someone commits
 * it. Seeds are fixed (start..start+seeds-1) and printed on failure, so a failing
 * seed is replayed by number; there is no shrinking.
 *
 * The space it samples (and nothing else): one mark of 4 kinds (rect over a band
 * scale, line, symbol, area) with an `update` block only, an x scale (band, linear
 * or pow) and a y scale (linear, sqrt or log), 2-10 inline rows, 0-2 axes. No
 * signals, expressions, transforms, legends, groups, `enter`, `zindex` or keys.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): every seed (every committed
 * reproducer in replay) must be compared, and a run that compares none fails;
 * `--seeds`/`--start` must be integers (`--seeds` at least 1).
 * `--plant-difference` adds a stray mark to Aster's SVG of every case.
 *
 *   pnpm fuzz                 # 200 seeds from 0
 *   pnpm fuzz -- --seeds 500 --start 200
 *   pnpm fuzz:replay          # every committed reproducer (gate `fuzz-replay`)
 *
 * Run after `pnpm build` (it renders through @aster-charts/core's dist).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSpec } from '@aster-charts/core'
import { renderWithVega } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { plantSvg } from '../src/gate-plant.js'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, intOption, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'

cli({ url: import.meta.url, flags: { replay: 'bool', clean: 'bool', seeds: 'value', start: 'value', ...GATE_FLAGS } })

const HERE = dirname(fileURLToPath(import.meta.url))
const REPRO = join(HERE, '..', 'fuzz-repro')

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!
const int = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))
const num = (rng: () => number, lo: number, hi: number): number => Math.round((lo + rng() * (hi - lo)) * 100) / 100

function makeSpec(seed: number): Record<string, unknown> {
  const rng = mulberry32(seed)
  const kind = pick(rng, ['bar', 'line', 'symbol', 'area'] as const)
  const width = int(rng, 160, 360)
  const height = int(rng, 100, 240)
  const n = int(rng, 2, 10)
  const discrete = kind === 'bar'
  const values = Array.from({ length: n }, (_, i) => {
    const x = i
    return {
      c: `c${i % Math.max(2, Math.floor(n / 2))}`,
      x,
      y: num(rng, 1, 30),
    }
  })
  const xScale = discrete
    ? { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: num(rng, 0, 0.5) }
    : pick(rng, [
        { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width', nice: rng() < 0.5 },
        { name: 'x', type: 'pow', domain: { data: 't', field: 'x' }, range: 'width', exponent: num(rng, 0.5, 2) },
      ] as const)
  // Bars anchor at scale(0), so log/sqrt domains would be invalid for them.
  const yScale = discrete
    ? { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height', zero: true, nice: rng() < 0.6 }
    : pick(rng, [
        { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height', zero: rng() < 0.7, nice: rng() < 0.6 },
        { name: 'y', type: 'sqrt', domain: [0, 40], range: 'height', nice: true },
        // Area baselines anchor at scale(0); only point/line marks can use log.
        ...(kind === 'area' ? [] : [{ name: 'y', type: 'log' as const, domain: [1, 100], range: 'height' }]),
      ] as const)
  const update: Record<string, unknown> = {
    x: discrete ? { scale: 'x', field: 'c' } : { scale: 'x', field: 'x' },
    y: { scale: 'y', field: 'y' },
  }
  if (discrete) {
    update.width = rng() < 0.5 ? { scale: 'x', band: 1 } : { scale: 'x', band: num(rng, 0.4, 1) }
    update.y2 = { scale: 'y', value: 0 }
    update.fill = { value: pick(rng, ['#4c78a8', '#e45756', '#54a24b', '#f58518']) }
  } else if (kind === 'line') {
    update.stroke = { value: pick(rng, ['#4c78a8', '#e45756', '#54a24b']) }
    update.strokeWidth = { value: int(rng, 1, 4) }
  } else if (kind === 'area') {
    update.fill = { value: pick(rng, ['#4c78a8', '#e45756', '#54a24b']) }
    update.fillOpacity = { value: num(rng, 0.3, 1) }
    update.y2 = { scale: 'y', value: 0 }
  } else {
    update.size = { value: int(rng, 20, 200) }
    update.fill = { value: pick(rng, ['#4c78a8', '#e45756', '#54a24b', '#f58518']) }
    update.shape = { value: pick(rng, ['circle', 'square', 'triangle', 'diamond']) }
  }
  const axes: Array<Record<string, unknown>> = []
  if (rng() < 0.9) axes.push({ scale: 'x', orient: 'bottom', grid: rng() < 0.3, title: rng() < 0.3 ? 'X' : undefined })
  if (rng() < 0.9) axes.push({ scale: 'y', orient: 'left', grid: rng() < 0.5, title: rng() < 0.3 ? 'Y' : undefined })
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width,
    height,
    padding: int(rng, 0, 12),
    autosize: 'none',
    background: 'white',
    data: [{ name: 't', values }],
    scales: [xScale, yScale],
    ...(axes.length ? { axes } : {}),
    marks: [{ type: kind === 'bar' ? 'rect' : kind === 'symbol' ? 'symbol' : kind, from: { data: 't' }, encode: { update } }],
  }
}

async function runOne(spec: Record<string, unknown>, plant: boolean): Promise<{ pass: boolean; diffs: string[]; error?: string }> {
  try {
    const [oracleSvg, ourSvg] = await Promise.all([renderWithVega(spec), Promise.resolve(renderSpec(spec as never))])
    const diffs = diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(plant ? plantSvg(ourSvg) : ourSvg))
    return { pass: diffs.length === 0, diffs }
  } catch (err) {
    return { pass: false, diffs: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function report(gate: Gate, name: string, result: { pass: boolean; diffs: string[]; error?: string }): void {
  if (result.error !== undefined) gate.error(name, result.error)
  else if (!result.pass) gate.differ(name, result.diffs[0]!)
  else gate.agree(name)
}

/** The committed reproducers (the gate `fuzz-replay`): a missing or empty directory compares nothing and fails. */
async function replay(gate: Gate): Promise<void> {
  const files = existsSync(REPRO) ? readdirSync(REPRO).filter((f) => f.endsWith('.vg.json')).sort() : []
  let passed = 0
  for (const f of files) {
    const spec = JSON.parse(readFileSync(join(REPRO, f), 'utf8')) as Record<string, unknown>
    const result = await runOne(spec, gate.plant)
    report(gate, `repro/${f}`, result)
    if (result.pass) passed++
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  repro/${f}${result.error ? `  (${result.error})` : ''}`)
    for (const d of result.diffs.slice(0, 6)) console.log(`      ${d}`)
  }
  console.log(`\n[fuzz] replay ${passed}/${files.length}`)
}

async function fuzz(gate: Gate, seeds: number, start: number): Promise<void> {
  mkdirSync(REPRO, { recursive: true })
  let failures = 0
  for (let s = start; s < start + seeds; s++) {
    const spec = makeSpec(s)
    const result = await runOne(spec, gate.plant)
    report(gate, `seed=${s}`, result)
    if (!result.pass) {
      failures++
      // (a planted difference is no reproducer: nothing is written)
      const file = join(REPRO, `fuzz-${s}.vg.json`)
      if (!gate.plant) writeFileSync(file, JSON.stringify(spec, null, 2) + '\n')
      console.log(`FAIL  seed=${s}${gate.plant ? '' : ` -> ${file}`}`)
      if (result.error) console.log(`      error: ${result.error}`)
      for (const d of result.diffs.slice(0, 8)) console.log(`      ${d}`)
    } else if (s % 25 === 0) {
      console.log(`PASS  seed=${s}`)
    }
  }
  console.log(`\n[fuzz] ${seeds - failures}/${seeds} passed (start=${start})`)
}

const argv = process.argv.slice(2)
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? '') : undefined
}
if (argv.includes('--clean') && existsSync(REPRO)) {
  // Remove only generated reproducers; keep the committed seed corpus/README.
  for (const f of readdirSync(REPRO)) {
    if (f.startsWith('fuzz-') && f.endsWith('.vg.json')) rmSync(join(REPRO, f), { force: true })
  }
}
if (argv.includes('--replay')) {
  await runGate({
    name: 'fuzz-replay',
    counters: { compared: { floor: 2, what: 'committed reproducers in fuzz-repro/ compared with the oracle' } },
    run: replay,
  })
} else {
  const seeds = intOption(value('seeds'), '--seeds', 200, { min: 1 })
  const start = intOption(value('start'), '--start', 0)
  // every seed asked for must be compared: the floor is the number of seeds
  await runGate({
    name: 'fuzz',
    counters: { compared: { floor: seeds, what: 'generated seeds compared with the oracle' } },
    run: (gate) => fuzz(gate, seeds, start),
  })
}
