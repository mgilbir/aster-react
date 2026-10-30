/**
 * Part of the gallery gate (`pnpm conformance:gallery`, which runs it with vitest.gallery.config.mjs after the cache is verified).
 * It needs the FETCHED gallery cache and headless Chromium, so the default `pnpm test` does not collect it (`*.gallery.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import { dataUrlsIn, listGallery } from './lib.js'
import { runReact } from './react.js'

describe('dataUrlsIn: the vendored files a spec names', () => {
  it('finds relative, absolute and jsdelivr urls anywhere in the spec, and nothing else', () => {
    const spec = {
      data: [{ name: 'a', url: 'data/cars.json' }, { name: 'b', values: [{ s: 'data/not-a-file.csv' }] }],
      layer: [{ data: { url: 'https://cdn.jsdelivr.net/npm/vega-datasets@v1.31.1/data/movies.json' } }],
      title: 'see https://example.com/data/cars.json',
    }
    expect(dataUrlsIn(spec)).toEqual(['https://cdn.jsdelivr.net/npm/vega-datasets@v1.31.1/data/movies.json', 'https://gallery.invalid/data/cars.json'])
  })
})

/** Block this process's event loop, as a CPU-bound task (the static path's renders, a loaded machine) does. */
const blockEventLoop = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

describe('a data load on the React path does not wait for the harness', () => {
  // time-units loads flights-20k.json (1.7 MB) through the chart's loader, whose per-request timeout is 10 s. From the moment the spec is
  // sent the harness is blocked in 11 s stretches with one poll phase between them: a file the page asks the harness for then cannot
  // arrive within 10 s (each request needs several turns). Preloaded into the page, nothing is asked of the harness while it runs.
  it('time-units passes while the harness is starved for longer than the loader timeout', { timeout: 100_000 }, async () => {
    const g = listGallery().find((s) => s.id === 'vega/time-units')!
    let starve = true
    const turn = (): void => { if (starve) { blockEventLoop(11_000); setImmediate(turn) } }
    try {
      const [o] = await runReact([g], () => { starve = false }, 1, { whileRunning: () => { setImmediate(turn) } })
      expect(o).toMatchObject({ id: 'vega/time-units', status: 'pass' })
    } finally { starve = false }
  })
})
