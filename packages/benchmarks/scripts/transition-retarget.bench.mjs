/**
 * What a scene that is not a change of data costs a running transition (a Vega-Lite `time` animation's clock ticking between
 * two frames, a signal no mark reads): the transition compares it with its end (`drawsSame`) and keeps its plan when it draws
 * the same; before that comparison existed, it planned the transition again (`createSceneTransition`) on every such scene.
 *
 * A keyed rect chart of `--size` items: `from` and `to` differ in every bar; `tick` draws like `to` (only a signal no mark
 * reads changed). It prints the median of 40 calls, per round, of: planning again; the comparison when `tick` shares no object
 * with `to` (each evaluation compiled afresh); the comparison when they share the mark (what an evaluation that reuses the
 * unchanged mark gives).
 *
 * Run: pnpm --filter @aster-charts/benchmarks run bench:transition-retarget [--size=1000] [--runs=3]   (after `pnpm build`)
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureBuilt } from '../src/ensure-built.ts'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url, flags: { size: 'eq', runs: 'eq' } })

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const argv = process.argv.slice(2)
const arg = (name, dflt) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
const N = Math.max(1, Number(arg('size', '1000')))
const RUNS = Math.max(1, Number(arg('runs', '3')))
ensureBuilt()

const CORE = join(ROOT, 'packages/core/dist')
const { compileChart, evaluateChart } = await import(pathToFileURL(join(CORE, 'index.js')).href)
const { createSceneTransition, drawsSame } = await import(pathToFileURL(join(CORE, 'transition.js')).href)

const spec = (v) => ({
  width: 600, height: 300, padding: 0, autosize: 'none',
  signals: [{ name: 'tick', value: 0 }],
  data: [{ name: 't', values: Array.from({ length: N }, (_, i) => ({ k: `r${i}`, x: (i % 300) * 2, v: v + (i % 7) })) }],
  scales: [{ name: 'y', type: 'linear', domain: [0, 20], range: 'height' }],
  marks: [{
    type: 'rect', from: { data: 't' }, key: 'k',
    encode: { update: { x: { field: 'x' }, width: { value: 2 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' } } },
  }],
})
const median = (f) => {
  const t = []
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now()
    f()
    t.push(performance.now() - t0)
  }
  t.sort((a, b) => a - b)
  return t[20].toFixed(3)
}

const from = evaluateChart(compileChart(spec(1)), {})
const to = evaluateChart(compileChart(spec(5)), {})
console.log(`[transition-retarget] ${N} keyed rects, median of 40 calls (ms)`)
for (let r = 1; r <= RUNS; r++) {
  const tick = evaluateChart(compileChart(spec(5)), { signals: { tick: r } })
  if (!drawsSame(to, tick)) throw new Error('the tick scene must draw like `to`')
  const shared = { ...tick, items: to.items }
  console.log(`  round ${r}: plan again ${median(() => createSceneTransition(from, tick, { maxItems: Infinity }))}   compare, no shared object ${median(() => drawsSame(to, tick))}   compare, shared mark ${median(() => drawsSame(to, shared))}`)
}
