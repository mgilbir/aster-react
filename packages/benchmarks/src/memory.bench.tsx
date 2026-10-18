/**
 * Memory benchmark (Node + jsdom, run with --expose-gc): heap retained per
 * mount/unmount cycle and heap growth across repeated data updates.
 *
 * Run: pnpm bench:memory [--points=1000] [--cycles=15]
 */
import { performance } from 'node:perf_hooks'
import { ensureBuilt } from './ensure-built.js'
import { table, fmt } from './stats.js'
import { waitForSettle, waitForSvg } from './settle.js'
import type { ChartKind } from './fixtures.js'
import type { EmbedName } from './embeds.js'

declare const gc: (() => void) | undefined

function heapUsed(): number {
  if (typeof gc !== 'function') throw new Error('run with --expose-gc')
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

async function main(): Promise<void> {
  ensureBuilt()
  const argv = process.argv.slice(2)
  const arg = (name: string, dflt: string): string =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
  const points = Number(arg('points', '1000'))
  const cycles = Number(arg('cycles', '15'))
  const kinds = (arg('kinds', 'line,scatter') as string).split(',') as ChartKind[]

  const { setupJsdom } = await import('./jsdom-env.js')
  setupJsdom()

  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { BenchEmbed, EMBEDS } = await import('./embeds.js')
  const { buildSpec, genValues } = await import('./fixtures.js')
  const h = React.createElement

  const rows: string[][] = []
  for (const kind of kinds) {
    for (const embedName of EMBEDS) {
      const specs = [0, 1, 2].map((i) => buildSpec(kind, genValues(kind, points, i + 1), 600, 400))

      // Warm one full cycle so lazy module init doesn't pollute the measurement.
      {
        const host = document.createElement('div')
        document.body.appendChild(host)
        const root = createRoot(host)
        root.render(h(BenchEmbed, { name: embedName, spec: specs[0]!, width: 600, height: 400 }))
        await waitForSvg(host, 30_000)
        await waitForSettle(host, { quietFrames: 2, timeoutMs: 30_000 })
        root.unmount()
        host.remove()
      }

      // Mount/unmount leak probe: heap retained per cycle after settle.
      const mountDeltas: number[] = []
      for (let c = 0; c < cycles; c++) {
        const before = heapUsed()
        const host = document.createElement('div')
        document.body.appendChild(host)
        const root = createRoot(host)
        root.render(h(BenchEmbed, { name: embedName, spec: specs[c % 3]!, width: 600, height: 400 }))
        await waitForSvg(host, 30_000)
        await waitForSettle(host, { quietFrames: 2, timeoutMs: 30_000 })
        root.unmount()
        host.remove()
        mountDeltas.push((heapUsed() - before) / 1024)
      }
      const perCycleMount = mean(mountDeltas)
      const mountSteady = mean(mountDeltas.slice(-5))

      // Update churn: steady heap growth across repeated data updates. Both a
      // whole-run mean and a steady-state mean (last 5 cycles) are reported:
      // the first updates pay one-time lazy-init costs (caches, module state),
      // which a whole-run mean amortizes into a phantom "per-update" growth.
      // The steady-state number is the leak signal.
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      root.render(h(BenchEmbed, { name: embedName, spec: specs[0]!, width: 600, height: 400 }))
      await waitForSvg(host, 30_000)
      await waitForSettle(host, { quietFrames: 2, timeoutMs: 30_000 })
      const updateDeltas: number[] = []
      for (let c = 0; c < cycles; c++) {
        const before = heapUsed()
        const spec = specs[(c + 1) % 3]!
        root.render(h(BenchEmbed, { name: embedName, spec, width: 600, height: 400 }))
        await waitForSettle(host, { quietFrames: 2, timeoutMs: 30_000 })
        updateDeltas.push((heapUsed() - before) / 1024)
      }
      const perCycleUpdate = mean(updateDeltas)
      const updateSteady = mean(updateDeltas.slice(-5))
      root.unmount()
      host.remove()

      rows.push([`${kind} @ ${points}`, embedName, fmt(perCycleMount, 1), fmt(mountSteady, 1), fmt(perCycleUpdate, 1), fmt(updateSteady, 1)])
    }
  }

  console.log(table('jsdom heap growth per mount/unmount + per update cycle (kB; mean + steady-state = last 5 cycles)', ['case', 'embed', 'mount mean', 'mount steady', 'update mean', 'update steady'], rows))
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
