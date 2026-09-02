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
      const setSpec = (s: Record<string, unknown>): Promise<void> => {
        spec = s
        return new Promise((resolve) => {
          root.render(h(BenchEmbed, { name: embedName, spec, width: Number((spec.width as number) ?? 600), height: Number((spec.height as number) ?? 400) }))
          setTimeout(resolve, 0)
        })
      }

      const mount: number[] = []
      const update: number[] = []
      const resize: number[] = []
      let nodes = 0

      // Warmup: compile all module state, JIT the paths, drop caches.
      for (let i = 0; i < warmup; i++) {
        await setSpec(i === 0 ? initialSpec : updatedSpec)
        await waitForSvg(host, 30_000)
        await timeWork(host, { quietFrames: 2, timeoutMs: 30_000 })
      }

      // Mount: fresh host each rep (the component is created from scratch).
      for (let i = 0; i < reps; i++) {
        const fresh = document.createElement('div')
        document.body.appendChild(fresh)
        const freshRoot = createRoot(fresh)
        const t0 = performance.now()
        freshRoot.render(h(BenchEmbed, { name: embedName, spec: initialSpec, width: 600, height: 400 }))
        // Observe from t0; the quiet window only starts once the svg is rendered.
        mount.push(await timeWork(fresh, { quietFrames: 2, timeoutMs: 30_000, t0, requireSvg: true }))
        if (i === reps - 1) {
          nodes = fresh.querySelectorAll('*').length
        }
        freshRoot.unmount()
        fresh.remove()
      }

      // Updates on the persistent root: spec.data values change, same shape.
      for (let i = 0; i < reps; i++) {
        const s = i % 2 === 0 ? updatedSpec : initialSpec
        const t0 = performance.now()
        await setSpec(s)
        update.push(await timeWork(host, { quietFrames: 2, timeoutMs: 30_000, t0 }))
      }

      // Resize: width/height change with identical data.
      for (let i = 0; i < reps; i++) {
        const s = i % 2 === 0 ? resizedSpec : updatedSpec
        const t0 = performance.now()
        await setSpec(s)
        resize.push(await timeWork(host, { quietFrames: 2, timeoutMs: 30_000, t0 }))
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
