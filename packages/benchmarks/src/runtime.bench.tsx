/**
 * Runtime benchmark (Node + jsdom): measures React-level mount, update,
 * and resize latency for each Vega-in-React embedding approach.
 *
 * Timings are relative, not absolute-browser numbers — see the browser bench.
 * The same DOM-quiescence protocol is applied to every embed.
 *
 * Run: pnpm bench:runtime  [--points=1000] [--reps=7]
 */
import { performance } from 'node:perf_hooks'
import { ensureBuilt } from './ensure-built.js'
import { summarize, table, fmt } from './stats.js'
import { timeWork, waitForSvg } from './settle.js'
import type { ChartKind } from './fixtures.js'
import type { EmbedName } from './embeds.js'

async function main(): Promise<void> {
  ensureBuilt()
  const argv = process.argv.slice(2)
  const arg = (name: string, dflt: string): string =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt

  const points = Number(arg('points', '1000'))
  const reps = Number(arg('reps', '7'))
  const kinds = (arg('kinds', 'line,scatter,bar') as string).split(',') as ChartKind[]
  const warmup = 2

  const { setupJsdom } = await import('./jsdom-env.js')
  setupJsdom()

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { BenchEmbed, EMBEDS } = await import('./embeds.js')
  const { buildSpec, genValues } = await import('./fixtures.js')
  const h = React.createElement

  interface RowResult {
    embed: EmbedName
    mount: number[]
    update: number[]
    resize: number[]
    nodes: number
  }

  const results: Record<ChartKind, RowResult[]> = {} as Record<ChartKind, RowResult[]>

  // Global warm-up: the first measured embed otherwise pays one-time module /
  // React / V8 initialisation (it looked ~2ms slower than the identical
  // `asterDom` path). Mount every embed once before any measurement.
  {
    const warmKind = kinds[0]!
    const warmSpec = buildSpec(warmKind, genValues(warmKind, points, 7), 600, 400)
    for (const embedName of EMBEDS) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await timeWork(host, {
        quietFrames: 1,
        timeoutMs: 30_000,
        requireSvg: true,
        trigger: () => root.render(h(BenchEmbed, { name: embedName, spec: warmSpec, width: 600, height: 400 })),
      })
      root.unmount()
      host.remove()
    }
  }

  for (const kind of kinds) {
    results[kind] = []
    for (const embedName of EMBEDS) {
      const initialValues = genValues(kind, points, 1)
      const initialSpec = buildSpec(kind, initialValues, 600, 400)
      const updatedValues = genValues(kind, points, 2)
      const updatedSpec = buildSpec(kind, updatedValues, 600, 400)
      const resizedSpec = buildSpec(kind, updatedValues, 800, 500)

      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)

      let spec = initialSpec
      // Trigger-based settle: the MutationObserver inside timeWork attaches
      // BEFORE root.render, so synchronous React commits (aster re-renders the
      // whole SVG in one commit) are captured. Observe-after-trigger misses
      // them and degrades to frame-quantized 'settled' timings.
      const settle = (s: Record<string, unknown>): Promise<number> =>
        timeWork(host, {
          quietFrames: 2,
          timeoutMs: 30_000,
          trigger: () => {
            spec = s
            root.render(
              h(BenchEmbed, {
                name: embedName,
                spec,
                width: Number((spec.width as number) ?? 600),
                height: Number((spec.height as number) ?? 400),
              }),
            )
          },
        })

      const mount: number[] = []
      const update: number[] = []
      const resize: number[] = []
      let nodes = 0

      // Warmup: compile all module state, JIT the paths, drop caches.
      for (let i = 0; i < warmup; i++) {
        await settle(i === 0 ? initialSpec : updatedSpec)
        await waitForSvg(host, 30_000)
      }

      // Discard one full mount so the measured reps don't pay first-mount JIT
      // (the first embed in the run was otherwise penalised by ~2x).
      {
        const fresh = document.createElement('div')
        document.body.appendChild(fresh)
        const freshRoot = createRoot(fresh)
        await timeWork(fresh, {
          quietFrames: 1,
          timeoutMs: 30_000,
          requireSvg: true,
          trigger: () => freshRoot.render(h(BenchEmbed, { name: embedName, spec: initialSpec, width: 600, height: 400 })),
        })
        freshRoot.unmount()
        fresh.remove()
      }

      // Mount: fresh host each rep (the component is created from scratch).
      for (let i = 0; i < reps; i++) {
        const fresh = document.createElement('div')
        document.body.appendChild(fresh)
        const freshRoot = createRoot(fresh)
        const t0 = performance.now()
        // Observe from t0; the quiet window only starts once the svg is rendered.
        mount.push(
          await timeWork(fresh, {
            quietFrames: 2,
            timeoutMs: 30_000,
            t0,
            requireSvg: true,
            trigger: () => freshRoot.render(h(BenchEmbed, { name: embedName, spec: initialSpec, width: 600, height: 400 })),
          }),
        )
        if (i === reps - 1) {
          nodes = fresh.querySelectorAll('*').length
        }
        freshRoot.unmount()
        fresh.remove()
      }

      // Updates on the persistent root: spec.data values change, same shape.
      for (let i = 0; i < reps; i++) {
        const s = i % 2 === 0 ? updatedSpec : initialSpec
        update.push(await settle(s))
      }

      // Resize: width/height change with identical data.
      for (let i = 0; i < reps; i++) {
        const s = i % 2 === 0 ? resizedSpec : updatedSpec
        resize.push(await settle(s))
      }

      root.unmount()
      host.remove()
      results[kind].push({ embed: embedName, mount, update, resize, nodes })
    }
  }

  for (const kind of kinds) {
    const rows = results[kind].map((r) => {
      const m = summarize(r.mount)
      const u = summarize(r.update)
      const z = summarize(r.resize)
      return [
        r.embed,
        `${fmt(m.median)} / ${fmt(m.p95)}`,
        `${fmt(u.median)} / ${fmt(u.p95)}`,
        `${fmt(z.median)} / ${fmt(z.p95)}`,
        String(r.nodes),
      ]
    })
    console.log(
      table(`jsdom timings (ms, median / p95) — ${kind} @ ${points} pts, ${reps} reps`, ['embed', 'mount', 'update', 'resize', 'nodes'], rows),
    )
    console.log('')
  }
  console.log('jsdom timings are relative (same-protocol comparison), not browser-realistic.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
