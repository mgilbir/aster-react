/**
 * Pipeline breakdown: where does one UPDATE go, stage by stage, aster vs Vega?
 *
 * aster per update: compileChart -> evaluateChart -> renderSceneToSvg (+ the
 * browser innerHTML re-parse, measured separately by the browser probe).
 * Vega per update: change() -> runAsync() on an already-parsed runtime; the
 * spec is parsed once at mount. Also times Vega's full mount (parse + first
 * run) and its serializer (toSVG) for like-for-like comparison.
 *
 * Pure computation, no DOM: this is what the engines cost before the browser
 * ever sees a byte.
 *
 * Run: pnpm bench:pipeline [--points=1000] [--reps=25]
 */
import { performance } from 'node:perf_hooks'
import { ensureBuilt } from './ensure-built.js'
import { summarize, table, fmt, type Summary } from './stats.js'
import type { ChartKind } from './fixtures.js'

async function main(): Promise<void> {
  ensureBuilt()
  const argv = process.argv.slice(2)
  const arg = (name: string, dflt: string): string =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
  const points = Number(arg('points', '1000'))
  const reps = Number(arg('reps', '25'))
  const kinds = (arg('kinds', 'line,scatter,bar') as string).split(',') as ChartKind[]

  const { buildSpec, genValues } = await import('./fixtures.js')
  const { compileChart, evaluateChart, renderSceneToSvg } = await import('@aster/core')
  const vega = await import('vega')

  const med = (s: Summary): string => `${fmt(s.median, 2)}`

  for (const kind of kinds) {
    // Pre-generate distinct specs so we never measure the same object twice.
    const specs = Array.from({ length: reps }, (_, i) => buildSpec(kind, genValues(kind, points, i + 1), 600, 400))

    const tCompile: number[] = []
    const tEval: number[] = []
    const tRender: number[] = []
    const tFull: number[] = []
    const tVegaRunMount: number[] = []
    const tVegaRunUpdate: number[] = []
    const tVegaSerialize: number[] = []
    let svgLen = 0

    // Warmup: JIT + lazy module init in both engines.
    {
      const chart = compileChart(specs[0] as never)
      const scene = evaluateChart(chart)
      renderSceneToSvg(scene)
      const rt = vega.parse(specs[0] as never)
      const view = new (vega as never as { View: new (r: never, o: { renderer: string }) => VegaView }).View(rt as never, { renderer: 'none' })
      await view.runAsync()
      view.finalize()
    }

    interface VegaView {
      runAsync(): Promise<unknown>
      change(name: string, cs: unknown): VegaView
      width(w: number): VegaView
      height(h: number): VegaView
      toSVG(): Promise<string>
      finalize(): void
    }
    // aster: full pipeline per update (spec object changes every rep).
    for (const spec of specs) {
      const t0 = performance.now()
      const chart = compileChart(spec as never)
      const t1 = performance.now()
      const scene = evaluateChart(chart)
      const t2 = performance.now()
      const svg = renderSceneToSvg(scene)
      const t3 = performance.now()
      tCompile.push(t1 - t0)
      tEval.push(t2 - t1)
      tRender.push(t3 - t2)
      tFull.push(t3 - t0)
      svgLen = svg.length
    }

    const changesetFactory = (vega as unknown as { changeset: () => { remove(p: () => boolean): { insert(v: unknown): unknown } } }).changeset
    // vega: exactly the embedHook lifecycle — parse+first run once (mount),
    // then change+runAsync on the same live view (updates).
    {
      const rt = vega.parse(specs[0] as never)
      const view: VegaView = new (vega as never as { View: new (r: never, o: { renderer: string }) => VegaView }).View(rt as never, { renderer: 'none' })
      const t0 = performance.now()
      await view.runAsync()
      tVegaRunMount.push(performance.now() - t0)
      for (const spec of specs) {
        const values = (spec.data as { values: unknown[] }[])[0]!.values
        const t1 = performance.now()
        view.change('table', changesetFactory().remove(() => true).insert(values))
        await view.runAsync()
        tVegaRunUpdate.push(performance.now() - t1)
        const t2 = performance.now()
        await view.toSVG()
        tVegaSerialize.push(performance.now() - t2)
      }
      view.finalize()
    }

    const c = summarize(tCompile), e = summarize(tEval), r = summarize(tRender)
    const vm = summarize(tVegaRunMount), vu = summarize(tVegaRunUpdate), vs = summarize(tVegaSerialize)
    console.log(
      table(
        `${kind} @ ${points} pts, ${reps} updates, compute only (ms, median) — svg ~${(svgLen / 1024).toFixed(0)} kB`,
        ['stage', 'aster', 'vega'],
        [
          ['compile/parse spec (per update)', med(c), '0.00 (parsed once at mount)'],
          ['dataflow evaluate/run', med(e), med(vu)],
          ['serialize (string, no DOM)', med(r), med(vs)],
          ['(vega full first run incl parse-equivalent)', '—', med(vm)],
          ['pipeline total', med(summarize(tFull)), '—'],
        ],
      ),
    )
    console.log('')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
