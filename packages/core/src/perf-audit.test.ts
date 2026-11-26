/**
 * The cost fixes of the final performance audit (docs/PERFORMANCE.md "Final audit"): each keeps what it speeds up exactly as it was.
 */
import { describe, it, expect } from 'vitest'
import { Hash53Stream, hash53 } from './svg-defs.js'
import { isDeepFrozen, noteDeepFrozen } from './session.js'
import { buildA11yTree } from './a11y.js'
import { compileChart, evaluateChart } from './index.js'
import { createChartStream } from './stream.js'
import type { SceneGroup, VgSpec } from './types.js'

/** A deterministic generator, so a failing case can be read back. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

describe('Hash53Stream', () => {
  it('digests the pieces as hash53 digests their concatenation, whatever the split', () => {
    const rnd = lcg(7)
    const alphabet = ['a', 'Z', '0', ':', '=', ';', ' ', 'é', '中', '😀', '\u0000']
    for (let n = 0; n < 400; n++) {
      const text = Array.from({ length: Math.floor(rnd() * 60) }, () => alphabet[Math.floor(rnd() * alphabet.length)]!).join('')
      const h = new Hash53Stream()
      let at = 0
      while (at < text.length) {
        const cut = Math.min(text.length, at + 1 + Math.floor(rnd() * 7))
        h.add(text.slice(at, cut))
        at = cut
      }
      expect(h.digest(), JSON.stringify(text)).toBe(hash53(text))
    }
    expect(new Hash53Stream().digest()).toBe(hash53(''))
  })
})

describe('noteDeepFrozen', () => {
  /** A frozen object that counts how often it is asked for its keys: a walk of it asks. */
  function counted(): { proxy: object; asked: () => number } {
    let asked = 0
    const target = Object.freeze({ a: 1, inner: Object.freeze({ b: 2 }) })
    const proxy = new Proxy(target, { ownKeys: (t) => { asked++; return Reflect.ownKeys(t) } })
    return { proxy, asked: () => asked }
  }

  it('answers isDeepFrozen for a noted object without walking it, and a walk still answers for one that is not noted', () => {
    const walked = counted()
    expect(isDeepFrozen(walked.proxy)).toBe(true)
    expect(walked.asked()).toBeGreaterThan(0)

    const noted = counted()
    noteDeepFrozen([noted.proxy])
    expect(isDeepFrozen(noted.proxy)).toBe(true)
    expect(noted.asked()).toBe(0)
  })
})

describe('a stream made over a spec with its rows in it', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ x: i % 50, y: (i * 7) % 40 }))
  const spec = {
    width: 120, height: 80, padding: 0, autosize: 'none',
    data: [{ name: 't', values: rows }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 50], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 40], range: 'height' }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } }],
  } as unknown as VgSpec

  it('appends the way a stream of a spec the host froze itself does', () => {
    const frozen = JSON.parse(JSON.stringify(spec)) as VgSpec
    const a = createChartStream(spec)
    const b = createChartStream(frozen)
    for (const s of [a, b]) { s.push({ append: { t: [{ x: 3, y: 4 }] } }); s.flush() }
    const items = (st: ReturnType<typeof createChartStream>): number => ((st.scene()!.items.find((g) => (g as SceneGroup).marktype === 'symbol') as SceneGroup).items?.length ?? 0)
    expect(items(a)).toBe(301)
    expect(items(b)).toBe(301)
  })
})

describe('accessible tree ids', () => {
  it("name a mark item by its mark and the hash of its datum's primitive fields, as before the hash was streamed", () => {
    const spec = {
      width: 100, height: 60, padding: 0, autosize: 'none',
      data: [{ name: 't', values: [{ k: 'a', v: 3 }, { k: 'b', v: 7 }, { k: 'a', v: 3 }] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 10 } } } }],
    } as never
    const tree = buildA11yTree(evaluateChart(compileChart(spec)), new Map())
    const marks = tree.nodes.filter((n) => n.kind === 'mark')
    const key = (k: string, v: number): string => `d${hash53(`1:k=string:${k};1:v=number:${v};`)}`
    const stem = marks[0]!.id.slice(0, marks[0]!.id.indexOf('-d'))
    expect(marks.map((n) => n.id)).toEqual([`${stem}-${key('a', 3)}`, `${stem}-${key('b', 7)}`, `${stem}-${key('a', 3)}_1`])
  })
})

describe("an expression runtime's view of the marks' items", () => {
  const spec = (reads: boolean): VgSpec => ({
    width: 100, height: 60, padding: 0, autosize: 'none',
    signals: [{ name: 'n', update: reads ? "length(data('pts'))" : '1' }],
    data: [{ name: 't', values: [{ x: 1 }, { x: 2 }, { x: 3 }] }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 4], range: 'width' }],
    marks: [{ type: 'symbol', name: 'pts', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 5 } } } }],
  } as unknown as VgSpec)

  it('is there after the evaluation for a chart that reads a mark by name, and is let go for one that does not', () => {
    const reading = evaluateChart(compileChart(spec(true)))
    const runtime = (reading as unknown as { runtime: { data: (name: string) => unknown[] | undefined } }).runtime
    expect(runtime.data('pts')?.length).toBe(3)
    const quiet = evaluateChart(compileChart(spec(false)))
    expect((quiet as unknown as { runtime: { data: (name: string) => unknown } }).runtime.data('pts')).toBeUndefined()
  })
})

describe('paintOrder over the items array the engine appends to', () => {
  type It = { id: number; zindex?: number }
  /** vega's order without any memory: the items whose zindex is falsy first, in order, then the others by zindex, ties in order. */
  const reference = (items: readonly It[]): It[] => {
    const flat = items.filter((i) => !i.zindex)
    const raised = items.map((item, index) => ({ item, index })).filter((x) => x.item.zindex).sort((a, b) => a.item.zindex! - b.item.zindex! || a.index - b.index)
    return [...flat, ...raised.map((x) => x.item)]
  }

  it('is the order of a full scan after any run of appends, stamped in-place edits and rollbacks', async () => {
    const { paintOrder } = await import('./paint-order.js')
    const rnd = lcg(99)
    for (let run = 0; run < 40; run++) {
      const items = Array.from({ length: 1100 + Math.floor(rnd() * 100) }, (_, i): It => ({ id: i })) as It[] & { __engineItems?: true; __editGen?: number }
      items.__engineItems = true
      let next = items.length
      let gen = 0
      for (let step = 0; step < 60; step++) {
        const r = rnd()
        if (r < 0.45) {
          const k = 1 + Math.floor(rnd() * 3)
          for (let j = 0; j < k; j++) items.push(rnd() < 0.08 ? { id: next++, zindex: 1 + Math.floor(rnd() * 3) } : { id: next++ })
        } else if (r < 0.65) {
          // an item replaced in place: the engine stamps the array
          const at = Math.floor(rnd() * items.length)
          items[at] = rnd() < 0.5 ? { id: next++, zindex: 2 } : { id: next++ }
          items.__editGen = ++gen
        } else if (r < 0.85) {
          // a rolled-back append, then another: the array is shorter, then as long as before with other items in the tail
          const drop = 1 + Math.floor(rnd() * 12)
          items.length = Math.max(1030, items.length - drop)
          for (let j = 0; j < drop + 2; j++) items.push(rnd() < 0.15 ? { id: next++, zindex: 1 } : { id: next++ })
        }
        expect(paintOrder(items).map((i) => i.id)).toEqual(reference(items).map((i) => i.id))
      }
    }
  })
})

describe('a running view does not keep the scenes it continued', () => {
  it('collects every scene but the last ones after any number of evaluations (a leak of one scene per update on the stack tip)', async () => {
    const { setFlagsFromString } = await import('node:v8')
    const { runInNewContext } = await import('node:vm')
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as (o?: { type: 'minor' | 'major' }) => void
    const { createChartSession } = await import('./session.js')
    const rows = (seed: number): Array<{ x: number; y: number }> => Array.from({ length: 200 }, (_, k) => ({ x: (k * 7 + seed) % 90, y: (k * 13 + seed) % 60 }))
    const spec = {
      width: 200, height: 100, padding: 5, autosize: 'pad',
      data: [{ name: 't', values: [] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 90], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 60], range: 'height' }],
      axes: [{ orient: 'bottom', scale: 'x' }, { orient: 'left', scale: 'y' }],
      marks: [{ type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } }],
    } as never
    const session = createChartSession({ runningView: true })
    let scene = session.evaluate(spec, { data: { t: rows(0) } })
    const seen: Array<WeakRef<object>> = []
    for (let i = 1; i <= 8; i++) {
      const next = session.evaluate(spec, { data: { t: rows(i) } })
      seen.push(new WeakRef(scene))
      scene = next
      await new Promise((r) => setImmediate(r))
    }
    gc({ type: 'major' })
    await new Promise((r) => setImmediate(r))
    gc({ type: 'major' })
    expect(seen.filter((r) => r.deref() !== undefined).length).toBeLessThanOrEqual(1)
  })
})
