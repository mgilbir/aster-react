import { describe, it, expect } from 'vitest'
import { AsterStreamBackpressureError, AsterStreamClosedError, createChartStream, getStreamFlushFailure, type StreamPolicy } from './stream.js'
import { AsterLimitError } from './limits.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import { renderSceneToSvg } from './index.js'
import type { RuntimeInput, VgSpec } from './types.js'

const spec = {
  width: 200, height: 100, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ x: 1, y: 2 }, { x: 5, y: 3 }] }],
  scales: [
    { name: 'sx', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width', zero: false },
    { name: 'sy', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height', zero: false },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'sx', field: 'x' }, y: { scale: 'sy', field: 'y' } } } }],
} as unknown as VgSpec

const domainOf = (scene: unknown, name: string): unknown[] =>
  ((scene as { __scaleMap: Map<string, { domain(): unknown[] }> }).__scaleMap.get(name)!).domain()

describe('stream batch overrides', () => {
  it('a null domainRaw value clears that scale override', () => {
    const stream = createChartStream(spec)
    stream.flush()
    const base = domainOf(stream.scene(), 'sx')
    stream.push({ domainRaw: { sx: [2, 3] } })
    stream.flush()
    expect(domainOf(stream.scene(), 'sx')).toEqual([2, 3])
    stream.push({ domainRaw: { sx: null } })
    stream.flush()
    expect(domainOf(stream.scene(), 'sx')).toEqual(base)
  })

  it('coalesced set+clear ends cleared', () => {
    const stream = createChartStream(spec)
    stream.flush()
    const base = domainOf(stream.scene(), 'sx')
    stream.push({ domainRaw: { sx: [2, 3] } })
    stream.push({ domainRaw: { sx: null } })
    stream.flush()
    expect(domainOf(stream.scene(), 'sx')).toEqual(base)
  })

  it('applies batch limits to later flushes, even over a cached scene', () => {
    const stream = createChartStream(spec)
    stream.flush()
    stream.push({ limits: { maxItems: 1 } })
    expect(() => stream.flush()).toThrow(AsterLimitError)
  })

  it('honours initial.limits and batch textMetrics', () => {
    expect(() => createChartStream(spec, { initial: { limits: { maxItems: 1 } } }).flush()).toThrow(AsterLimitError)
    const calls: string[] = []
    const stream = createChartStream({
      ...(spec as object),
      title: { text: 'hello' },
    } as unknown as VgSpec)
    stream.push({ textMetrics: { measure: (t) => { calls.push(t); return t.length } } })
    stream.flush()
    expect(calls).toContain('hello')
  })
})

// ---------------------------------------------------------------------------
// Fixtures for the ordering / atomicity / backpressure tests below
// ---------------------------------------------------------------------------

type Row = { id: number; x: number; v: number; g: string }
const row = (id: number, v = id % 7, g = 'ABCD'[id % 4]!): Row => ({ id, x: id, v, g })
const rowsOf = (from: number, n: number): Row[] => Array.from({ length: n }, (_, i) => row(from + i))

const titled = {
  width: 200, height: 100, padding: 5, autosize: 'none',
  title: { text: 'hello' },
  signals: [{ name: 'sig', value: 0 }],
  data: [{ name: 't' }, { name: 'other' }],
  scales: [
    { name: 'sx', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width', zero: false },
    { name: 'sy', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height' },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'sx', field: 'x' }, y: { scale: 'sy', field: 'v' } } } }],
} as unknown as VgSpec

const counted = {
  width: 200, height: 100, padding: 5, autosize: 'none',
  data: [{ name: 't' }, { name: 'c', source: 't', transform: [{ type: 'aggregate', groupby: ['g'], ops: ['count'], fields: [null], as: ['n'] }] }],
  scales: [
    { name: 'sx', type: 'band', domain: { data: 'c', field: 'g' }, range: 'width' },
    { name: 'sy', type: 'linear', domain: { data: 'c', field: 'n' }, range: 'height' },
  ],
  marks: [{ type: 'rect', from: { data: 'c' }, encode: { update: { x: { scale: 'sx', field: 'g' }, width: { scale: 'sx', band: 1 }, y: { scale: 'sy', field: 'n' }, y2: { value: 0 } } } }],
} as unknown as VgSpec

const fresh = (spec: VgSpec, input: RuntimeInput): string =>
  renderSceneToSvg(evaluateChart(compileChart(structuredClone(spec)), input))

// ---------------------------------------------------------------------------
// C18: batch order
// ---------------------------------------------------------------------------

describe('stream batch order (C18)', () => {
  const POLICIES: StreamPolicy[] = ['coalesce', 'drop-oldest', 'drop-newest', 'error']
  for (const policy of POLICIES) {
    it(`${policy}: snapshot then append in one queue keeps the appended rows`, () => {
      const stream = createChartStream(titled, { policy, capacity: 8 })
      stream.flush()
      stream.push({ data: { t: rowsOf(10, 2) } })
      stream.push({ append: { t: rowsOf(12, 1) } })
      stream.flush()
      expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: rowsOf(10, 3) } }))
    })
    it(`${policy}: a snapshot and an append in ONE batch applies the snapshot first`, () => {
      const stream = createChartStream(titled, { policy })
      stream.push({ append: { t: rowsOf(1, 2) } })
      stream.flush()
      stream.push({ data: { t: rowsOf(10, 2) }, append: { t: rowsOf(12, 2) } })
      stream.flush()
      expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: rowsOf(10, 4) } }))
    })
  }

  it('a later snapshot clears an earlier explicit pulse', () => {
    const stream = createChartStream(titled)
    stream.push({ append: { t: rowsOf(1, 4) } })
    stream.flush()
    // An explicit "row 1 changed" pulse, then a snapshot that replaces everything.
    stream.push({ pulse: { t: { changed: [1] } } })
    const next = [row(1), row(2), row(3), row(40)]
    stream.push({ data: { t: next } })
    const pending = stream.pending()
    // The snapshot diff is authoritative: only the row that differs is reported.
    expect(pending.datasets.get('t')?.changed ?? []).not.toContain(1)
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: next } }))
  })

  it('a same-length explicit pulse plus an append never loses the in-place change', () => {
    const rows = rowsOf(1, 4)
    const stream = createChartStream(titled, { initial: { data: { t: rows } } })
    stream.flush()
    rows[2]!.v = 90 // in-place edit of a row the stream already holds
    stream.push({ append: { t: rowsOf(5, 2) }, pulse: { t: { changed: [2] } } })
    const pending = stream.pending().datasets.get('t')!
    expect(pending.appendOnly).toBe(true)
    expect(pending.changed).toEqual([2])
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: [...rows, ...rowsOf(5, 2)] } }))
  })

  it('an in-place pulse followed by a snapshot that reuses the edited rows is re-derived', () => {
    const rows = rowsOf(1, 4)
    const stream = createChartStream(titled, { initial: { data: { t: rows } } })
    stream.flush()
    rows[1]!.v = 80
    stream.push({ pulse: { t: { changed: [1] } } })
    stream.push({ data: { t: rows.slice() } }) // same row objects: a diff alone would see nothing
    stream.push({ append: { other: [row(1)] } }) // another dataset changes, so unaffected marks are reused
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: rows, other: [row(1)] } }))
  })

  it('an explicit pulse that cannot compose marks the dataset for a full re-derive, never an empty pulse', () => {
    const rows = rowsOf(1, 4)
    const stream = createChartStream(titled, { initial: { data: { t: rows } } })
    stream.flush()
    rows[0]!.v = 70
    // The mapping claims 6 rows but the batch only brings 5: it cannot compose.
    stream.push({ append: { t: rowsOf(5, 1) }, pulse: { t: { changed: [0], from: [0, 1, 2, 3, -1, -1] } } })
    const pending = stream.pending()
    expect(pending.structural.has('t')).toBe(true)
    expect(pending.datasets.has('t')).toBe(false)
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: [...rows, ...rowsOf(5, 1)] } }))
  })

  it('composes successive explicit mapped pulses', () => {
    const stream = createChartStream(titled, { initial: { data: { t: rowsOf(1, 4) } } })
    stream.flush()
    // remove row index 1, then insert at the end
    const afterRemove = [row(1), row(3), row(4)]
    const final = [...afterRemove, row(9)]
    stream.push({ data: { t: afterRemove }, pulse: { t: { changed: [], from: [0, 2, 3] } } })
    stream.push({ data: { t: final }, pulse: { t: { changed: [], from: [0, 1, 2, -1] } } })
    const d = stream.pending().datasets.get('t')!
    expect(d.from).toEqual([0, 2, 3, -1])
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: final } }))
  })

  it('later signals/size/domainRaw/limits/textMetrics win, in push order', () => {
    const stream = createChartStream(titled)
    stream.flush()
    stream.push({ signals: { sig: 1 }, width: 120, domainRaw: { sx: [0, 5] } })
    stream.push({ signals: { sig: 2 }, width: 150, domainRaw: { sx: [0, 9] } })
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(
      fresh(titled, { signals: { sig: 2 }, width: 150, domainRaw: { sx: [0, 9] } }),
    )
  })
})

// ---------------------------------------------------------------------------
// C91: large appends
// ---------------------------------------------------------------------------

describe('stream large batches (C91)', () => {
  const N = 300_000
  const big = (from: number): Row[] => Array.from({ length: N }, (_, i) => ({ id: from + i, x: i, v: i % 7, g: 'ABCD'[i % 4]! }))
  for (const policy of ['coalesce', 'drop-oldest', 'error'] as StreamPolicy[]) {
    it(`${policy}: two 300k-row appends flush without a stack overflow`, () => {
      const stream = createChartStream(counted, { policy, capacity: 4 })
      stream.flush()
      expect(stream.push({ append: { t: big(0) } })).toBe(true)
      expect(stream.push({ append: { t: big(N) } })).toBe(true)
      const out = stream.flush()!
      expect(out.scene).toBeTruthy()
      // 600k rows over four groups: each count is 150k.
      const counts = (out.scene.items[0] as { items: Array<{ datum: { n: number } }> }).items.map((i) => i.datum.n)
      expect(counts).toEqual([150_000, 150_000, 150_000, 150_000])
    }, 60_000)
  }
  it('a snapshot of 300k rows followed by a 300k append coalesces', () => {
    const stream = createChartStream(counted)
    stream.flush()
    stream.push({ data: { t: big(0) } })
    stream.push({ append: { t: big(N) } })
    const out = stream.flush()!
    const counts = (out.scene.items[0] as { items: Array<{ datum: { n: number } }> }).items.map((i) => i.datum.n)
    expect(counts).toEqual([150_000, 150_000, 150_000, 150_000])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// C19: a throwing flush leaves the stream exactly as before it
// ---------------------------------------------------------------------------

describe('stream flush atomicity (C19)', () => {
  const goodMetrics = { measure: (t: string) => t.length }
  interface Stage {
    name: string
    /** Fields that make the flush throw. */
    poison: Record<string, unknown>
    /** A batch that removes the cause (replaces the budget / measurer). */
    heal: Record<string, unknown>
    /** Arm any lazy poison right before the flush. */
    arm?: () => void
  }
  const stages: Stage[] = [
    { name: 'spec pre-flight (maxMarks)', poison: { limits: { maxMarks: 0 } }, heal: { limits: {} } },
    { name: 'scene limit (maxItems)', poison: { limits: { maxItems: 1 } }, heal: { limits: {} } },
    { name: 'deadline (maxTimeMs 0)', poison: { limits: { maxTimeMs: 0 } }, heal: { limits: {} } },
    { name: 'stream row budget (maxRows)', poison: { limits: { maxRows: 2 } }, heal: { limits: {} } },
  ]
  for (const policy of ['coalesce', 'drop-oldest', 'error'] as StreamPolicy[]) {
    for (const stage of stages) {
      it(`${policy} / ${stage.name}: queue, rows, stats and signals are restored and the next flush works`, () => {
        const base = rowsOf(1, 4)
        const stream = createChartStream(titled, { policy, capacity: 8 })
        // Make the base an owned, in-place-appended array first.
        stream.push({ data: { t: base } })
        stream.flush()
        stream.push({ append: { t: rowsOf(5, 2) } })
        stream.flush()
        const sceneBefore = stream.scene()
        const statsBefore = stream.stats()
        const appended = rowsOf(7, 3)
        stream.push({ append: { t: appended }, signals: { sig: 3 }, width: 150, domainRaw: { sx: [0, 50] }, ...stage.poison })
        const queued = stream.stats()
        const pendingBefore = stream.pending()
        let thrown: unknown
        try { stream.flush() } catch (e) { thrown = e }
        expect(thrown).toBeDefined()
        // Every stage's error carries what is still queued.
        expect(getStreamFlushFailure(thrown)).toEqual({ batches: queued.depth, queuedRows: queued.queuedRows })
        // Exactly as before the flush.
        expect(stream.scene()).toBe(sceneBefore)
        expect(stream.stats()).toEqual(queued)
        expect(stream.stats().flushes).toBe(statsBefore.flushes)
        expect(stream.stats().dropped).toBe(statsBefore.dropped)
        expect(stream.pending().datasets.get('t')?.addedRanges).toEqual(pendingBefore.datasets.get('t')?.addedRanges)
        expect(stream.pending().datasets.get('t')?.baseLength).toBe(6)
        // The failed batch is still queued: heal it and flush; its rows land exactly once.
        stream.push(stage.heal)
        const out = stream.flush()!
        expect(out).toBeTruthy()
        expect(renderSceneToSvg(out.scene)).toBe(
          fresh(titled, { data: { t: [...base, ...rowsOf(5, 2), ...appended] }, signals: { sig: 3 }, width: 150, domainRaw: { sx: [0, 50] } }),
        )
        expect(stream.stats().flushes).toBe(statsBefore.flushes + 1)
        expect(stream.stats().depth).toBe(0)
      })
    }
  }

  it('an expression error raised by a bad row restores the stream, and a corrected snapshot then applies', () => {
    const exprSpec = {
      ...(titled as object),
      data: [{ name: 't', transform: [{ type: 'formula', expr: 'datum.o.k', as: 'ok' }] }],
    } as unknown as VgSpec
    const withO = (r: Row): Row & { o: { k: number } } => ({ ...r, o: { k: r.id } })
    const good = rowsOf(1, 4).map(withO)
    const stream = createChartStream(exprSpec)
    stream.push({ data: { t: good } })
    stream.flush()
    stream.push({ append: { t: rowsOf(5, 1).map(withO) } })
    stream.flush() // base is an owned array now
    const sceneBefore = stream.scene()
    const before = stream.stats()
    stream.push({ append: { t: [row(6)] }, signals: { sig: 2 } }) // no `o`: datum.o.k throws
    const queued = stream.stats()
    let thrown: unknown
    try { stream.flush() } catch (e) { thrown = e }
    expect(thrown).toBeDefined()
    expect(getStreamFlushFailure(thrown)).toEqual({ batches: queued.depth, queuedRows: queued.queuedRows })
    expect(stream.scene()).toBe(sceneBefore)
    expect(stream.stats()).toEqual(queued)
    expect(stream.stats().flushes).toBe(before.flushes)
    // The rows were not committed: the pulse is still relative to 5 rows.
    expect(stream.pending().datasets.get('t')?.baseLength).toBe(5)
    const fixed = [...good, withO(row(5)), withO(row(6))]
    stream.push({ data: { t: fixed } })
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(exprSpec, { data: { t: fixed }, signals: { sig: 2 } }))
  })

  it('a failed FIRST flush does not poison the stream', () => {
    const stream = createChartStream(titled, { initial: { limits: { maxItems: 1 } } })
    let thrown: unknown
    try { stream.flush() } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(AsterLimitError)
    expect(getStreamFlushFailure(thrown)).toEqual({ batches: 0, queuedRows: 0 })
    expect(stream.scene()).toBeNull()
    stream.push({ limits: {}, append: { t: rowsOf(1, 3) } })
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: rowsOf(1, 3) } }))
  })
})

// ---------------------------------------------------------------------------
// C91 / C49: honest backpressure, close(), and options
// ---------------------------------------------------------------------------

describe('stream backpressure bounds', () => {
  it('coalesce reports the bound that really holds memory', () => {
    const stream = createChartStream(titled, { capacity: 32, maxQueuedRows: 10 })
    expect(stream.stats()).toMatchObject({ capacity: 1, maxQueuedRows: 10, queuedRows: 0 })
    expect(stream.canAccept()).toBe(true)
    expect(stream.push({ append: { t: rowsOf(1, 6) } })).toBe(true)
    expect(stream.push({ append: { t: rowsOf(7, 4) } })).toBe(true)
    expect(stream.stats()).toMatchObject({ depth: 1, queuedRows: 10, coalesced: 1 })
    expect(stream.canAccept()).toBe(false)
    // Over the row bound: rejected, nothing queued is lost, the drop is counted.
    expect(stream.push({ append: { t: rowsOf(11, 1) } })).toBe(false)
    expect(stream.stats()).toMatchObject({ queuedRows: 10, dropped: 1 })
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: rowsOf(1, 10) } }))
    expect(stream.stats().queuedRows).toBe(0)
    expect(stream.canAccept()).toBe(true)
  })

  it('a snapshot replaces queued rows instead of adding to them', () => {
    const stream = createChartStream(titled, { maxQueuedRows: 10 })
    stream.push({ append: { t: rowsOf(1, 8) } })
    expect(stream.push({ data: { t: rowsOf(1, 9) } })).toBe(true)
    expect(stream.stats().queuedRows).toBe(9)
  })

  it('a batch larger than the row bound is always refused', () => {
    for (const policy of ['coalesce', 'drop-oldest', 'drop-newest'] as StreamPolicy[]) {
      const stream = createChartStream(titled, { policy, maxQueuedRows: 5 })
      expect(stream.push({ append: { t: rowsOf(1, 6) } })).toBe(false)
      expect(stream.stats()).toMatchObject({ queuedRows: 0, depth: 0, dropped: 1 })
    }
    const strict = createChartStream(titled, { policy: 'error', maxQueuedRows: 5 })
    expect(() => strict.push({ append: { t: rowsOf(1, 6) } })).toThrow(AsterStreamBackpressureError)
  })

  it('a paused consumer cannot grow the queue past either bound, under any policy', () => {
    for (const policy of ['coalesce', 'drop-oldest', 'drop-newest', 'error'] as StreamPolicy[]) {
      const stream = createChartStream(titled, { policy, capacity: 4, maxQueuedRows: 50 })
      let peakRows = 0
      let peakDepth = 0
      for (let i = 0; i < 500; i++) {
        try { stream.push({ append: { t: rowsOf(i * 3, 3) } }) } catch (e) { expect(e).toBeInstanceOf(AsterStreamBackpressureError) }
        const s = stream.stats()
        peakRows = Math.max(peakRows, s.queuedRows)
        peakDepth = Math.max(peakDepth, s.depth)
      }
      expect(peakRows, policy).toBeLessThanOrEqual(50)
      expect(peakDepth, policy).toBeLessThanOrEqual(policy === 'coalesce' ? 1 : 4)
    }
  })

  it('drop-oldest sheds whole oldest batches to satisfy the row bound', () => {
    const stream = createChartStream(titled, { policy: 'drop-oldest', capacity: 10, maxQueuedRows: 10 })
    stream.push({ append: { t: rowsOf(1, 4) } })
    stream.push({ append: { t: rowsOf(5, 4) } })
    expect(stream.push({ append: { t: rowsOf(9, 4) } })).toBe(true)
    expect(stream.stats()).toMatchObject({ depth: 2, queuedRows: 8, dropped: 1 })
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: [...rowsOf(5, 4), ...rowsOf(9, 4)] } }))
  })

  it('AsterStreamBackpressureError carries a stable code and the bound that was hit', () => {
    const byBatches = createChartStream(titled, { policy: 'error', capacity: 1 })
    byBatches.push({ signals: { sig: 1 } })
    let err: unknown
    try { byBatches.push({ signals: { sig: 2 } }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(AsterStreamBackpressureError)
    expect(err).toMatchObject({ code: 'ASTER_STREAM_BACKPRESSURE', bound: 'batches', limit: 1, name: 'AsterStreamBackpressureError' })
    const byRows = createChartStream(titled, { policy: 'error', maxQueuedRows: 2 })
    try { byRows.push({ append: { t: rowsOf(1, 3) } }) } catch (e) { err = e }
    expect(err).toMatchObject({ code: 'ASTER_STREAM_BACKPRESSURE', bound: 'rows', limit: 2 })
  })
})

describe('stream close()', () => {
  it('releases the queue, rows, scene and session; later calls are typed no-ops', () => {
    const stream = createChartStream(titled, { initial: { data: { t: rowsOf(1, 3) } } })
    stream.flush()
    stream.push({ append: { t: rowsOf(4, 2) } })
    expect(stream.scene()).not.toBeNull()
    stream.close()
    expect(stream.scene()).toBeNull()
    expect(stream.pulse()).toBeNull()
    expect(stream.stats()).toMatchObject({ depth: 0, queuedRows: 0 })
    expect(stream.push({ append: { t: rowsOf(9, 1) } })).toBe(false)
    expect(stream.flush()).toBeNull()
    expect(stream.canAccept()).toBe(false)
    expect(stream.pending().datasets.size).toBe(0)
    expect(() => stream.session()).toThrow(AsterStreamClosedError)
    expect(() => stream.session()).toThrow(expect.objectContaining({ code: 'ASTER_STREAM_CLOSED' }))
    stream.close() // idempotent
    // The rows were released: nothing is left to replay from a flush.
    expect(stream.flush()).toBeNull()
  })

  it('does not count pushes after close as backpressure drops', () => {
    const stream = createChartStream(titled)
    stream.close()
    stream.push({ signals: { sig: 1 } })
    expect(stream.stats().dropped).toBe(0)
  })
})

describe('stream limits (C49)', () => {
  it('honours options.limits and options.textMetrics like the session does', () => {
    expect(() => createChartStream(titled, { limits: { maxItems: 1 } }).flush()).toThrow(AsterLimitError)
    expect(() => createChartStream(titled, { limits: { maxMarks: 0 } }).flush()).toThrow(AsterLimitError)
    expect(() => createChartStream(titled, { limits: { maxTimeMs: 0 } }).flush()).toThrow(AsterLimitError)
    const calls: string[] = []
    const stream = createChartStream(titled, { textMetrics: { measure: (t) => { calls.push(t); return t.length } } })
    stream.flush()
    expect(calls).toContain('hello')
  })

  it('enforces maxRows over streamed rows, which the spec-literal check cannot see', () => {
    const stream = createChartStream(titled, { limits: { maxRows: 5 } })
    stream.push({ append: { t: rowsOf(1, 5) } })
    stream.flush()
    stream.push({ append: { t: rowsOf(6, 1) } })
    let thrown: unknown
    try { stream.flush() } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(AsterLimitError)
    expect(getStreamFlushFailure(thrown)).toEqual({ batches: 1, queuedRows: 1 })
    expect(stream.stats().depth).toBe(1)
    // A snapshot that fits replaces the over-budget append.
    stream.push({ data: { t: rowsOf(1, 4) } })
    stream.flush()
    expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(titled, { data: { t: rowsOf(1, 4) } }))
  })
})

// ---------------------------------------------------------------------------
// Recovery from a failed flush: discard()
// ---------------------------------------------------------------------------

describe('stream discard() recovery', () => {
  const exprSpec = {
    ...(titled as object),
    data: [{ name: 't', transform: [{ type: 'formula', expr: 'datum.o.k', as: 'ok' }] }],
  } as unknown as VgSpec
  const withO = (r: Row): Row & { o: { k: number } } => ({ ...r, o: { k: r.id } })

  for (const policy of ['coalesce', 'drop-oldest', 'error'] as StreamPolicy[]) {
    it(`${policy}: a bad batch followed by good ones keeps failing until discard(); then only later data applies`, () => {
      const stream = createChartStream(exprSpec, { policy, capacity: 8 })
      const good = rowsOf(1, 3).map(withO)
      stream.push({ data: { t: good } })
      stream.flush()
      const sceneBefore = stream.scene()
      stream.push({ append: { t: [row(9)] } }) // no `o`: throws
      stream.push({ append: { t: [withO(row(10))] } })
      const queuedBefore = stream.stats()
      let err: unknown
      try { stream.flush() } catch (e) { err = e }
      expect(err).toBeInstanceOf(Error)
      // typed info about what is still queued; the original error is unchanged
      expect(getStreamFlushFailure(err)).toEqual({ batches: queuedBefore.depth, queuedRows: queuedBefore.queuedRows })
      expect(() => stream.flush()).toThrow() // stuck without recovery
      expect(stream.scene()).toBe(sceneBefore)

      const droppedBefore = stream.stats().dropped
      expect(stream.discard()).toBe(queuedBefore.depth)
      expect(stream.stats()).toMatchObject({ depth: 0, queuedRows: 0, dropped: droppedBefore + queuedBefore.depth })
      expect(stream.discard()).toBe(0)
      // Healthy again: exactly the good data pushed after the discard point.
      const after = withO(row(11))
      stream.push({ append: { t: [after] } })
      stream.flush()
      expect(renderSceneToSvg(stream.scene()!)).toBe(fresh(exprSpec, { data: { t: [...good, after] } }))
    })
  }

  it('discard() on a stream with nothing queued, or after close, is a no-op returning 0', () => {
    const stream = createChartStream(titled)
    expect(stream.discard()).toBe(0)
    stream.push({ signals: { sig: 1 } })
    stream.close()
    expect(stream.discard()).toBe(0)
    expect(stream.stats().dropped).toBe(0)
  })
})

describe('stream image url policy', () => {
  const imgSpec = {
    width: 50, height: 50, padding: 0, autosize: 'none',
    data: [{ name: 't', values: [{ u: 'https://good.example/a.png' }, { u: 'https://evil.example/b.png' }] }],
    marks: [{ type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, x: { value: 0 }, y: { value: 0 } } } }],
  } as unknown as VgSpec

  it('initial.urlPolicy applies to every flush (denied images dropped via onDeny)', () => {
    const denied: string[] = []
    const stream = createChartStream(imgSpec, {
      initial: { urlPolicy: { allow: (u) => u.host === 'good.example', onDeny: (u) => { denied.push(u) } } },
    })
    stream.flush()
    expect(denied).toEqual(['https://evil.example/b.png'])
    stream.push({ append: { t: [{ u: 'https://evil.example/c.png' }] } })
    stream.flush()
    expect(denied).toContain('https://evil.example/c.png')
  })
})
