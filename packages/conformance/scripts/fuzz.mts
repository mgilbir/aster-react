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
 * Two spaces per seed. The chart space: one mark of 4 kinds (rect over a band
 * scale, line, symbol, area) with an `update` block only, an x scale (band, linear
 * or pow) and a y scale (linear, sqrt or log), 2-10 inline rows, 0-2 axes. The
 * scene space (makeSceneSpec): what is between items and across blocks: nesting in
 * plain and faceted groups, `enter` + `update` splitting a channel, item and mark
 * `zindex`, colour objects, signal-driven encoders, keys (duplicates too), a
 * filter / formula / stack transform, a legend.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): every seed (every committed
 * reproducer in replay) must be compared, and a run that compares none fails;
 * `--seeds`/`--start` must be integers (`--seeds` at least 1).
 * `--plant-difference` adds a stray mark to Aster's SVG of every case.
 *
 *   pnpm fuzz                 # 200 seeds from 0
 *   pnpm fuzz -- --seeds 500 --start 200
 *   pnpm fuzz:replay          # every committed reproducer (gate `fuzz-replay`)
 *   [--repro-dir=<path>]      # read and write the reproducers there instead of fuzz-repro/
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

cli({ url: import.meta.url, flags: { replay: 'bool', clean: 'bool', seeds: 'value', start: 'value', 'repro-dir': 'eq', ...GATE_FLAGS } })

const HERE = dirname(fileURLToPath(import.meta.url))
/** `--repro-dir=<path>` reads (and writes) the reproducers elsewhere (the self-test points replay at an empty directory). */
const REPRO = process.argv.slice(2).find((a) => a.startsWith('--repro-dir='))?.slice('--repro-dir='.length) ?? join(HERE, '..', 'fuzz-repro')

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


/**
 * The scene generator (C249): what the chart generator above never draws, between items and across blocks. One to three
 * marks of seven types, at the top level or inside a group mark (plain or faceted), each with an `enter` and an `update`
 * block that split a channel between them (x in enter, x2 or width in update); per-item `zindex` from a field and a mark's
 * own `zindex`; paints as colour objects ({r,g,b}, {h,s,l}, {h,c,l}, {l,a,b}) and as signal expressions; a signal read by
 * the encoders; a mark `key`, with duplicate keys at times; a filter / formula / stack transform; a legend.
 */
export function makeSceneSpec(seed: number): Record<string, unknown> {
  const rng = mulberry32(seed ^ 0x5ce4e)
  const n = int(rng, 2, 12)
  const values = Array.from({ length: n }, (_, i) => ({
    c: `c${i % int(rng, 2, 4)}`,
    k: rng() < 0.2 ? 'dup' : `k${i}`,
    x: num(rng, 0, 100),
    y: num(rng, 0, 50),
    z: int(rng, -2, 3),
    g: `g${i % 2}`,
  }))
  const transform: Array<Record<string, unknown>> = []
  if (rng() < 0.3) transform.push({ type: 'filter', expr: `datum.x > ${num(rng, 0, 50)}` })
  if (rng() < 0.3) transform.push({ type: 'formula', as: 'w', expr: 'datum.y * k' })
  if (rng() < 0.25) transform.push({ type: 'stack', groupby: ['c'], field: 'y' })
  const colour = (): unknown => pick(rng, [
    { value: pick(rng, ['#4c78a8', 'firebrick', 'rgba(20,120,60,0.6)']) },
    { color: { r: { value: int(rng, 0, 255) }, g: { field: 'z' }, b: { value: 120 } } },
    { color: { h: { field: 'x' }, s: { value: 0.6 }, l: { value: 0.5 } } },
    { color: { h: { value: 200 }, c: { value: 40 }, l: { field: 'y' } } },
    { color: { l: { value: 60 }, a: { field: 'z' }, b: { value: -20 } } },
    { signal: "datum.z > 0 ? 'steelblue' : 'orange'" },
    { scale: 'color', field: 'c' },
  ])
  const markOf = (type: string, from: Record<string, unknown>): Record<string, unknown> => {
    const enter: Record<string, unknown> = {}
    const update: Record<string, unknown> = {}
    const blk = (): Record<string, unknown> => (rng() < 0.5 ? enter : update)
    blk().x = { scale: 'x', field: 'x' }
    if (type === 'rect') {
      if (rng() < 0.5) blk().x2 = { scale: 'x', field: 'x', offset: int(rng, 4, 20) }
      else blk().width = { value: int(rng, 3, 15) }
      blk().y = { scale: 'y', field: 'y' }
      blk().y2 = { scale: 'y', value: 0 }
    } else if (type === 'rule') {
      blk().x2 = { scale: 'x', field: 'x', offset: 10 }
      blk().y = { scale: 'y', field: 'y' }
      blk().stroke = colour()
    } else if (type === 'arc') {
      blk().y = { scale: 'y', field: 'y' }
      blk().outerRadius = { value: int(rng, 5, 20) }
      blk().endAngle = { signal: 'datum.z + 4' }
    } else if (type === 'text') {
      blk().y = { scale: 'y', field: 'y' }
      blk().text = { field: 'k' }
    } else {
      blk().y = { scale: 'y', field: 'y' }
      if (type === 'area') blk().y2 = { scale: 'y', value: 0 }
      if (type === 'symbol') blk().size = { signal: '20 + datum.z * k' }
    }
    if (type !== 'rule') blk().fill = colour()
    if (rng() < 0.5) blk().zindex = { field: 'z' }
    if (rng() < 0.3) blk().opacity = { value: num(rng, 0.3, 1) }
    const m: Record<string, unknown> = { type, from, encode: { enter, update } }
    if (rng() < 0.3) m.zindex = int(rng, 0, 3)
    if (rng() < 0.3) m.key = rng() < 0.5 ? 'k' : 'c'
    return m
  }
  const types = ['rect', 'symbol', 'text', 'rule', 'line', 'area', 'arc'] as const
  const marks = Array.from({ length: int(rng, 1, 3) }, () => markOf(pick(rng, types), { data: 't' }))
  const nested = rng() < 0.4
  const facet = nested && rng() < 0.5
  const body = nested
    ? [{
        type: 'group',
        ...(facet ? { from: { facet: { name: 'f', data: 't', groupby: 'g' } } } : {}),
        encode: { update: { x: facet ? { signal: "datum.g === 'g0' ? 0 : 20" } : { value: 10 }, y: { value: 5 }, width: { signal: 'width' }, height: { signal: 'height' } } },
        ...(rng() < 0.3 ? { zindex: 1 } : {}),
        marks: marks.map((m) => (facet ? { ...m, from: { data: 'f' } } : m)),
      }, ...(rng() < 0.5 ? [markOf(pick(rng, types), { data: 't' })] : [])]
    : marks
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: int(rng, 160, 320),
    height: int(rng, 100, 200),
    padding: 5,
    autosize: 'none',
    background: 'white',
    signals: [{ name: 'k', value: num(rng, 0.5, 4) }],
    data: [{ name: 't', values, ...(transform.length ? { transform } : {}) }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 120], range: 'width' },
      { name: 'y', type: 'linear', domain: [-10, 160], range: 'height' },
      { name: 'color', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' },
    ],
    ...(rng() < 0.3 ? { legends: [{ fill: 'color', orient: pick(rng, ['right', 'bottom']) }] } : {}),
    marks: body,
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

function report(gate: Gate, name: string, result: { pass: boolean; diffs: string[]; error?: string }, counter?: string): void {
  if (result.error !== undefined) gate.error(name, result.error)
  else if (!result.pass) gate.differ(name, result.diffs[0]!, counter)
  else gate.agree(name, counter)
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
    for (const [space, spec] of [['chart', makeSpec(s)], ['scene', makeSceneSpec(s)]] as const) {
      const result = await runOne(spec, gate.plant)
      const name = space === 'chart' ? `seed=${s}` : `scene seed=${s}`
      report(gate, name, result, space === 'chart' ? 'compared' : 'scenes')
      if (!result.pass) {
        failures++
        // (a planted difference is no reproducer: nothing is written)
        const file = join(REPRO, `fuzz-${space === 'chart' ? '' : 'scene-'}${s}.vg.json`)
        if (!gate.plant) writeFileSync(file, JSON.stringify(spec, null, 2) + '\n')
        console.log(`FAIL  ${name}${gate.plant ? '' : ` -> ${file}`}`)
        if (result.error) console.log(`      error: ${result.error}`)
        for (const d of result.diffs.slice(0, 8)) console.log(`      ${d}`)
      } else if (s % 25 === 0) {
        console.log(`PASS  ${name}`)
      }
    }
  }
  console.log(`\n[fuzz] ${2 * seeds - failures}/${2 * seeds} passed (start=${start}; chart and scene spaces)`)
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
    counters: {
      compared: { floor: seeds, what: 'generated charts compared with the oracle' },
      scenes: { floor: seeds, what: 'generated scenes (nesting, enter+update, zindex, colour objects, keys) compared' },
    },
    run: (gate) => fuzz(gate, seeds, start),
  })
}
