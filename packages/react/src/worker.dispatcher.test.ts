/**
 * The worker's message dispatcher answers every request it can name, in arrival order, whatever `post` does (C160), and the
 * real worker entry runs it (the entry was never executed by a test, C718).
 *
 * Generated: sequences of one-shot and stream messages, some needing an add-on import (the queued path) and some not, with the
 * k-th `post` throwing (a response that cannot be structured-cloned). Every message must be answered exactly once, in arrival
 * order; the one whose post threw is answered with a wire error for its own id. Before the fix a throw on the queued path
 * rejected the dispatcher's chain and every later message waited for good.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChartStream } from '@aster-charts/core'

/** A fresh module registry: the add-ons are not loaded, so a geo message takes the queued (import) path. */
async function fresh(): Promise<typeof import('./worker-impl')> {
  vi.resetModules()
  const W = await import('./worker-impl')
  expect(W.prepareWorkerMessage({ id: 0, spec: geo }).missing.length).toBeGreaterThan(0)
  return W
}

const plain = { width: 50, height: 20, marks: [{ type: 'rect', encode: { enter: { width: { value: 5 }, height: { value: 5 } } } }] }
// (needs the geo and transforms add-ons: the queued path, while they are not loaded in this realm)
const geo = {
  width: 50, height: 20,
  projections: [{ name: 'p', type: 'mercator' }],
  data: [{ name: 'pts', values: [{ lon: 0, lat: 0 }], transform: [{ type: 'geopoint', projection: 'p', fields: ['lon', 'lat'] }] }],
  marks: [{ type: 'symbol', from: { data: 'pts' }, encode: { enter: { x: { field: 'x' }, y: { field: 'y' } } } }],
}

type Response = { id: number; error?: { message: string } }

/** Wait until `done()` (the import of an add-on is a module load: its time is not ours to fix), at most 10 s. */
async function settle(done: () => boolean = () => false, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
  // and a little more, so a late extra answer would be seen
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 2))
}

describe('createWorkerDispatcher never stops answering (C160)', () => {
  // shapes: which messages need an import; which post throws
  const SHAPES: Array<{ kinds: Array<'geo' | 'plain'>; throwAt: number }> = []
  for (const kinds of [['geo', 'plain', 'plain', 'plain'], ['plain', 'geo', 'plain', 'geo'], ['geo', 'geo', 'plain'], ['plain', 'plain', 'plain']] as Array<Array<'geo' | 'plain'>>) {
    for (let throwAt = 0; throwAt < kinds.length; throwAt++) SHAPES.push({ kinds, throwAt })
  }

  it.each(SHAPES)('$kinds, post #$throwAt throws: every message answered once, in order', async ({ kinds, throwAt }) => {
    const out: Response[] = []
    let posts = 0
    let thrown = false
    const { createWorkerDispatcher } = await fresh()
    const dispatch = createWorkerDispatcher(new Map<number, ChartStream>(), (r) => {
      const n = posts++
      if (n === throwAt && !thrown) {
        thrown = true
        throw new DOMException('simulated: could not be cloned', 'DataCloneError')
      }
      out.push(r as Response)
    })
    kinds.forEach((k, i) => dispatch({ id: i + 1, spec: k === 'geo' ? geo : plain }))
    await settle(() => out.length >= kinds.length)
    expect(out.map((r) => r.id)).toEqual(kinds.map((_, i) => i + 1))
    const failed = out.filter((r) => r.error)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error!.message).toMatch(/cloned/)
  })

  it('a post that throws even for the error answer is reported as the worker error event, and the queue goes on', async () => {
    const out: Response[] = []
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => { uncaught.push(e) }
    process.on('uncaughtException', onUncaught)
    try {
      let fails = 2
      const { createWorkerDispatcher } = await fresh()
      const dispatch = createWorkerDispatcher(new Map<number, ChartStream>(), (r) => {
        if (fails-- > 0) throw new Error('cannot post')
        out.push(r as Response)
      })
      dispatch({ id: 1, spec: geo })
      dispatch({ id: 2, spec: plain })
      await settle(() => out.length >= 1 && uncaught.length >= 1)
      expect(out.map((r) => r.id)).toEqual([2])
      expect(uncaught).toHaveLength(1)
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})

describe('the worker entry', () => {
  it('installs the dispatcher as onmessage and posts its answers', async () => {
    const posted: Response[] = []
    const scope = globalThis as unknown as { onmessage?: (e: { data: unknown }) => void; postMessage?: (r: unknown) => void }
    const before = { onmessage: scope.onmessage, postMessage: scope.postMessage }
    scope.postMessage = (r) => { posted.push(r as Response) }
    try {
      vi.resetModules()
      await import('./worker-entry')
      expect(typeof scope.onmessage).toBe('function')
      scope.onmessage!({ data: { id: 7, spec: plain } })
      scope.onmessage!({ kind: 'stream' } as never) // (no data: dropped, there is nobody to answer)
      scope.onmessage!({ data: { kind: 'stream', id: 8, streamId: 9, op: 'init', spec: geo } })
      scope.onmessage!({ data: { kind: 'stream', id: 10, streamId: 9, op: 'flush', batches: [{ append: { pts: [{ lon: 1, lat: 1 }] } }] } })
      await settle(() => posted.length >= 3)
      expect(posted.map((r) => r.id)).toEqual([7, 8, 10])
      expect(posted.every((r) => !r.error)).toBe(true)
    } finally {
      scope.onmessage = before.onmessage
      scope.postMessage = before.postMessage
    }
  })
})
