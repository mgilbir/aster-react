/**
 * The histories a scene keeps of its datasets (content-stamp.ts, DECISIONS Q14) must not keep the arrays they describe alive past
 * the scenes that read them. A table keyed by an array whose value holds that array keeps it through every minor GC (V8's scavenger
 * takes an old table's values as roots), so each array a session evaluation published -- the host's rows -- was promoted and
 * lived until the next full collection: at 10k rows, scavenges of ~4 ms instead of ~0.3 ms on every session update.
 *
 * Measured, not inferred: after many evaluations, each with a new array of rows, and minor collections between them, only the
 * arrays the session still holds survive a minor GC.
 *
 * The measurement needs an engine whose minor GC frees an unreachable array that a WeakRef points at. The V8 of Node 22 keeps
 * WeakRef targets through scavenges: there, a control array that nothing references survives as long as a given one, so the count
 * says nothing about the session, and the test is skipped, saying why. The control is made the same way as the given arrays, at the
 * same moments, so the engine decides for both alike. It runs where the engine can measure it (Node 26 and 27 were checked;
 * CI's latest-Node unit leg runs it).
 */
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as (o?: { type: 'minor' | 'major' }) => void
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

const rows = (n: number): Array<{ x: number; y: number }> => Array.from({ length: n }, (_, k) => ({ x: (k % 100) / 100, y: k % 10 }))
const spec = {
  width: 200, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: rows(10) }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 200] }, { name: 'y', type: 'linear', domain: [0, 10], range: [100, 0] }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } }],
} as const

describe('a session does not keep the rows it was given alive through minor collections', () => {
  for (const kind of ['same-length edit', 'append'] as const) {
    it(kind, async (ctx) => {
      const session = createChartSession()
      let cur = rows(2000)
      session.evaluate(spec as never, { data: { t: cur } })
      const given: Array<WeakRef<object>> = []
      const control: Array<WeakRef<object>> = [] // the same arrays, never given to the session
      for (let i = 0; i < 60; i++) {
        const next = kind === 'append' ? [...cur, { x: 0.5, y: i % 10 }] : cur.slice()
        if (kind !== 'append') next[i] = { x: 0.5, y: i % 10 }
        session.evaluate(spec as never, { data: { t: next } })
        given.push(new WeakRef(next))
        control.push(new WeakRef(next.slice()))
        cur = next
        await tick()
        gc({ type: 'minor' })
      }
      for (let k = 0; k < 3; k++) { await tick(); gc({ type: 'minor' }) }
      const alive = given.filter((w) => w.deref() !== undefined).length
      const controlAlive = control.filter((w) => w.deref() !== undefined).length
      if (controlAlive > 10) ctx.skip(`this engine's minor GC kept ${controlAlive} of 60 unreferenced control arrays (WeakRef targets survive scavenges here): it cannot measure what the session keeps`)
      // (the session holds the last array it was given; a minor GC may run before a young array is old enough to die: a handful, whatever the number of evaluations)
      expect(alive).toBeLessThanOrEqual(10)
    })
  }
})
