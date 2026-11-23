import { describe, it, expect } from 'vitest'
import { checkBrowserBench, checkStreamBench, streamCells, type BrowserResults, type DifferentialStages, type StreamMatrix, type StreamRow } from './browser-floors.js'

const S = (median: number): { median: number; p95: number } => ({ median, p95: median * 1.3 })
const embeds = (aster: number, vega: number): Record<string, unknown> => ({ aster: S(aster), asterDom: S(aster), reactVega: S(vega), embedHook: S(vega * 0.9) })

/** A run shaped like a measured one (line @ 1000 points, memory measured). */
function good(): { results: BrowserResults; diff: DifferentialStages } {
  const frames = { median: 16.7, p95: 17.3, longShare: 0, frames: 178 }
  const resize = { lags: [17, 17, 17, 17], median: 17, resized: 4, total: 4 }
  const stable = { ms: S(0.3), mutations: [0, 0, 0] }
  const heap = { retainedMB: 0.3, nodesAfter: 80 }
  const all = (v: unknown): Record<string, unknown> => ({ aster: v, asterDom: v, reactVega: v, embedHook: v })
  return {
    results: {
      'mount:line': embeds(2.4, 3.4),
      'update:line': embeds(2.9, 3.5),
      'fps:line': all(frames),
      'autoResize:line': all(resize),
      'stable:line': all(stable),
      'heap:line': all(heap),
    },
    diff: { fullEval: [0.3, 0.3, 0.3], fullPatch: [0.8, 0.8, 0.8], diffEval: [0.1, 0.1, 0.1], diffPatch: [0.1, 0.1, 0.1] },
  }
}
const MEM = { memory: true }

describe('checkBrowserBench', () => {
  it('passes a run like a measured one', () => {
    const { results, diff } = good()
    expect(checkBrowserBench(results, ['line'], [], diff, MEM)).toEqual([])
  })

  it('FAILS when the default mode is slower than the FASTER Vega embed by more than the floor (update and first render)', () => {
    const a = good(); a.results['update:line'] = { aster: S(2.9), asterDom: S(9), reactVega: S(30), embedHook: S(3.5) }
    expect(checkBrowserBench(a.results, ['line'], [], a.diff, MEM).join('\n')).toMatch(/asterDom update is 2\.57x the faster Vega embed/)
    const b = good(); b.results['mount:line'] = { aster: S(2.4), asterDom: S(9), reactVega: S(30), embedHook: S(3.5) }
    expect(checkBrowserBench(b.results, ['line'], [], b.diff, MEM).join('\n')).toMatch(/asterDom mount is/)
  })

  it('compares with the faster Vega embed, not the slower: 3.1x slower than vega-embed does not hide behind react-vega (bar, 25 ms against 8.3)', () => {
    const g = good(); g.results['update:line'] = { aster: S(8), asterDom: S(25), reactVega: S(16.75), embedHook: S(8.3) }
    const text = checkBrowserBench(g.results, ['line'], [], g.diff, MEM).join('\n')
    expect(text).toMatch(/asterDom update is 3\.01x the faster Vega embed \(25\.0 ms against 8\.3 ms\)/)
    expect(text).toMatch(/asterDom update is 3\.13x string mode/)
  })

  it('string mode has its own, looser floor against the Vega embeds', () => {
    const ok = good(); ok.results['update:line'] = { aster: S(11.5), asterDom: S(8.6), reactVega: S(19), embedHook: S(8.8) } // measured: bar, string mode 1.31x
    expect(checkBrowserBench(ok.results, ['line'], [], ok.diff, MEM)).toEqual([])
    const bad = good(); bad.results['update:line'] = { aster: S(30), asterDom: S(8.6), reactVega: S(19), embedHook: S(8.8) }
    expect(checkBrowserBench(bad.results, ['line'], [], bad.diff, MEM).join('\n')).toMatch(/aster update is 3\.41x the faster Vega embed/)
  })

  it('FAILS when the incremental patcher is much slower than string mode (the 10x asterDom that used to pass)', () => {
    const g = good(); g.results['update:line'] = { aster: S(1), asterDom: S(3), reactVega: S(30), embedHook: S(3.5) }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM).join('\n')).toMatch(/asterDom update is 3\.00x string mode/)
  })

  it('FAILS when an identical-content re-render writes to the DOM', () => {
    const g = good(); g.results['stable:line'] = { ...g.results['stable:line'], aster: { ms: S(1), mutations: [0, 3, 0] } }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM).join('\n')).toMatch(/aster wrote to the DOM on an identical-content re-render/)
  })

  it('FAILS when the chart does not follow its container (the 0/4 the old harness printed and nobody read)', () => {
    const g = good(); g.results['autoResize:line'] = { ...g.results['autoResize:line'], aster: { lags: [-1, -1, -1, -1], median: NaN, resized: 0, total: 4 } }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM).join('\n')).toMatch(/aster followed 0 of 4 container resizes/)
    delete g.results['autoResize:line']
    expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM).join('\n')).toMatch(/aster has no container-resize measurement/)
  })

  it('FAILS when frames are dropped, none were painted, or the page threw', () => {
    const g = good(); g.results['fps:line'] = { ...g.results['fps:line'], asterDom: { median: 40, p95: 90, longShare: 0.6, frames: 100 }, aster: { median: 16.7, p95: 17, longShare: 0, frames: 0 } }
    const text = checkBrowserBench(g.results, ['line'], ['boom'], g.diff, MEM).join('\n')
    expect(text).toMatch(/asterDom drops 60\.0% of its frames/)
    expect(text).toMatch(/aster painted no frames/)
    expect(text).toMatch(/the benchmark page threw: boom/)
  })

  it('string mode may drop frames on a heavy chart (measured 64% on bar) but not stop painting', () => {
    const g = good(); g.results['fps:line'] = { ...g.results['fps:line'], aster: { median: 22.2, p95: 33.6, longShare: 0.642, frames: 123 } }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM)).toEqual([])
    g.results['fps:line'] = { ...g.results['fps:line'], aster: { median: 90, p95: 120, longShare: 0.98, frames: 30 } }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM).join('\n')).toMatch(/aster drops 98\.0% of its frames/)
  })

  it('FAILS when the differential update is not cheaper than a full re-encode', () => {
    const g = good(); g.diff = { fullEval: [0.3], fullPatch: [0.8], diffEval: [0.3], diffPatch: [0.7] }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM).join('\n')).toMatch(/differential update is 1\.1x cheaper/)
  })

  it('FAILS on a run that measured nothing: no kinds, no timings, no differential', () => {
    expect(checkBrowserBench({}, [], [], undefined).join('\n')).toMatch(/no chart kind was measured/)
    expect(checkBrowserBench({}, ['line'], [], undefined).join('\n')).toMatch(/line: aster update: no measurement/)
    expect(checkBrowserBench(good().results, ['line'], [], undefined, MEM).join('\n')).toMatch(/no differential staging measurement/)
  })

  it('FAILS on a leaking heap, and when the heap was to be measured and was not', () => {
    const g = good(); g.results['heap:line'] = { ...g.results['heap:line'], aster: { retainedMB: 80 } }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM).join('\n')).toMatch(/aster retains 80\.0 MB/)
    const none = good(); delete none.results['heap:line']
    expect(checkBrowserBench(none.results, ['line'], [], none.diff, MEM).join('\n')).toMatch(/aster heap after churn: no measurement/)
    // a run that did not ask for the heap is not failed for lacking it
    expect(checkBrowserBench(none.results, ['line'], [], none.diff, { memory: false })).toEqual([])
  })
})

// C197: a measurement that is missing, undefined or NaN used to pass every floor (`undefined > 10` is false). Each field of each row,
// removed and set to NaN, one at a time, must now fail.
describe('checkBrowserBench never passes on a missing or non-finite measurement (generated)', () => {
  const FIELDS: Array<[string, string, string[]]> = [
    ['mount:line', 'timing', ['median', 'p95']],
    ['update:line', 'timing', ['median', 'p95']],
    ['fps:line', 'frame pacing', ['median', 'p95', 'longShare', 'frames']],
    ['autoResize:line', 'container resize', ['total', 'resized']],
    ['heap:line', 'heap', ['retainedMB']],
  ]
  for (const embed of ['aster', 'asterDom', 'reactVega', 'embedHook']) {
    for (const [key, , fields] of FIELDS) {
      for (const field of fields) {
        for (const [how, value] of [['missing', undefined], ['NaN', NaN], ['a string', '7'], ['null', null]] as const) {
          it(`${key} ${embed}.${field} ${how}`, () => {
            const g = good()
            const row = { ...(g.results[key]![embed] as Record<string, unknown>) }
            if (value === undefined) delete row[field]; else row[field] = value
            g.results[key] = { ...g.results[key], [embed]: row }
            expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM), `${key} ${embed}.${field} ${how}`).not.toEqual([])
          })
        }
      }
    }
    for (const key of ['mount:line', 'update:line', 'fps:line', 'autoResize:line', 'stable:line', 'heap:line']) {
      it(`${key} has no row for ${embed}`, () => {
        const g = good()
        const rest = { ...g.results[key] }
        delete rest[embed]
        g.results[key] = rest
        expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM), `${key} lacks ${embed}`).not.toEqual([])
      })
    }
  }
  it('stable-content mutation counts that are missing or NaN fail', () => {
    for (const mutations of [[NaN], [undefined], [], undefined, ['0']]) {
      const g = good(); g.results['stable:line'] = { ...g.results['stable:line'], asterDom: { ms: S(1), mutations } }
      expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM), JSON.stringify(mutations)).not.toEqual([])
    }
  })
  it('every kind asked for is checked, not only the first', () => {
    const g = good()
    expect(checkBrowserBench(g.results, ['line', 'scatter'], [], g.diff, MEM).join('\n')).toMatch(/scatter: aster update: no measurement/)
  })
  it('a differential stage with a missing or NaN array fails', () => {
    for (const k of ['fullEval', 'fullPatch', 'diffEval', 'diffPatch'] as const) {
      for (const bad of [[], [NaN], undefined]) {
        const g = good(); (g.diff as unknown as Record<string, unknown>)[k] = bad
        expect(checkBrowserBench(g.results, ['line'], [], g.diff, MEM), `${k} ${JSON.stringify(bad)}`).not.toEqual([])
      }
    }
  })
})

const row = (over: Partial<StreamRow>): StreamRow => ({
  points: 10_000, engine: 'aster', renderer: 'svg', policy: 'microtask', dense: '0',
  median: 16.7, p95: 17.5, longShare: 0.04, frames: 178, updates: 173, mutations: 173, nodes: 10_175, ...over,
})

describe('checkStreamBench', () => {
  it('passes rows like a measured run, including the dense pair at 100,000 points', () => {
    const rows = [
      row({}), row({ renderer: 'canvas', mutations: 0, nodes: 4 }),
      row({ points: 100_000, median: 154, longShare: 0.94, frames: 20, updates: 19, mutations: 19, nodes: 100_030 }),
      row({ points: 100_000, dense: '1', median: 33, longShare: 0.97, frames: 90, updates: 88, mutations: 88, nodes: 402 }),
    ]
    expect(checkStreamBench(rows, [])).toEqual([])
  })

  it('FAILS when an append rebuilds the DOM (mutations per append), or appends stall', () => {
    expect(checkStreamBench([row({ mutations: 173 * 242 })], []).join('\n')).toMatch(/242\.0 DOM mutations per append/)
    expect(checkStreamBench([row({ updates: 10 })], []).join('\n')).toMatch(/only 10 appends in 178 frames/)
  })

  it('does not fail a loaded machine on which every engine is slow (frames are compared with vega in the same run)', () => {
    const slow = row({ median: 39.6, longShare: 0.986, frames: 74, updates: 73, mutations: 73 })
    const vega = row({ engine: 'vega', policy: 'run', median: 42, longShare: 1, frames: 65, updates: 64, mutations: 64 * 242 })
    expect(checkStreamBench([slow, vega], [])).toEqual([])
  })

  it('FAILS when aster falls behind vega view.change in the same run (appends, median frame)', () => {
    const vega = row({ engine: 'vega', policy: 'run', median: 16.7, frames: 178, updates: 174 })
    const text = checkStreamBench([row({ median: 60, frames: 60, updates: 58, mutations: 58 }), vega], []).join('\n')
    expect(text).toMatch(/58 appends against 174 for vega view\.change/)
    expect(text).toMatch(/median frame 60\.0 ms against 16\.7 ms for vega view\.change/)
  })

  it('FAILS when denseMarks stops batching (nodes, frame time, appends)', () => {
    const plain = row({ points: 100_000, median: 154, frames: 20, updates: 19, nodes: 100_030, mutations: 19 })
    const text = checkStreamBench([plain, row({ points: 100_000, dense: '1', median: 150, frames: 20, updates: 19, nodes: 100_030, mutations: 19 })], []).join('\n')
    expect(text).toMatch(/100030 DOM nodes against 100030 per-item/)
    expect(text).toMatch(/median frame 150\.0 ms against 154\.0 ms per-item/)
    expect(text).toMatch(/19 appends against 19 per-item/)
  })

  it('FAILS on a run with no aster row, no frames, or a page error', () => {
    expect(checkStreamBench([row({ engine: 'vega' })], []).join('\n')).toMatch(/no aster row/)
    expect(checkStreamBench([row({ frames: 0 })], []).join('\n')).toMatch(/no frames were painted/)
    expect(checkStreamBench([row({})], ['x is not defined']).join('\n')).toMatch(/page threw: x is not defined/)
  })

  it('FAILS when a field of a row is missing or NaN (every comparison on it would have passed)', () => {
    for (const f of ['points', 'median', 'p95', 'longShare', 'frames', 'updates', 'mutations', 'nodes'] as const) {
      for (const bad of [undefined, NaN, '5', null]) {
        const r = row({ [f]: bad } as unknown as Partial<StreamRow>)
        expect(checkStreamBench([r, row({ renderer: 'canvas', mutations: 0 })], []), `${f}=${String(bad)}`).not.toEqual([])
      }
    }
    // the cases the audit found passing
    expect(checkStreamBench([row({ updates: undefined as unknown as number })], []).join('\n')).toMatch(/updates is undefined/)
    expect(checkStreamBench([row({ mutations: NaN })], []).join('\n')).toMatch(/mutations is NaN/)
    expect(checkStreamBench([row({ points: 100_000, dense: '1', nodes: undefined as unknown as number, median: undefined as unknown as number, updates: undefined as unknown as number }), row({ points: 100_000 })], []).join('\n')).toMatch(/dense/)
  })

  it('FAILS when vega is part of the run and its row is missing or painted nothing (the comparison used to be skipped)', () => {
    const m: StreamMatrix = { points: [10_000], engines: ['aster', 'vega'], renderers: ['svg'], policies: { aster: ['microtask'], vega: ['run'] }, dense: ['0'] }
    const noVega = checkStreamBench([row({})], [], m).join('\n')
    expect(noVega).toMatch(/vega\/svg\/run @ 10000: the run was asked for this row and has none/)
    expect(noVega).toMatch(/no usable vega view\.change row at 10000 points/)
    const zero = checkStreamBench([row({}), row({ engine: 'vega', policy: 'run', frames: 0, updates: 0, median: 0 })], [], m).join('\n')
    expect(zero).toMatch(/no usable vega view\.change row at 10000 points/)
  })

  it('FAILS when a dense row has no per-item row, or the run lacks a row it was asked for', () => {
    expect(checkStreamBench([row({ points: 100_000, dense: '1', median: 33, frames: 90, updates: 88, mutations: 88, nodes: 402 })], []).join('\n')).toMatch(/no per-item row at 100000 points/)
    const m: StreamMatrix = { points: [100_000], engines: ['aster'], renderers: ['svg'], policies: { aster: ['microtask', 'raf'] }, dense: ['0', '1'] }
    expect(streamCells(m).length).toBe(4)
    expect(checkStreamBench([row({ points: 100_000, median: 154, frames: 20, updates: 19, mutations: 19, nodes: 100_030 })], [], m).join('\n')).toMatch(/aster\/svg\/raf\/dense @ 100000: the run was asked for this row and has none/)
  })

  it('FAILS a run of only canvas rows asked to include svg', () => {
    const m: StreamMatrix = { points: [10_000], engines: ['aster'], renderers: ['svg', 'canvas'], policies: { aster: ['microtask'] }, dense: ['0'] }
    expect(checkStreamBench([row({ renderer: 'canvas', mutations: 0, nodes: 4 })], [], m).join('\n')).toMatch(/aster\/svg\/microtask @ 10000: the run was asked for this row/)
  })

  it('the heavy append floors: per-item at 100,000 points and the batched rows each have their own', () => {
    expect(checkStreamBench([row({ points: 100_000, median: 154, frames: 20, updates: 3, mutations: 3, nodes: 100_030 })], []).join('\n')).toMatch(/only 3 appends completed; floor 4/)
    expect(checkStreamBench([row({ points: 100_000, median: 154, frames: 20, updates: 19, mutations: 19, nodes: 100_030 }), row({ points: 100_000, dense: '1', median: 33, frames: 90, updates: 40, mutations: 40, nodes: 402 })], []).join('\n')).not.toMatch(/only 40 appends/)
    expect(checkStreamBench([row({ points: 100_000, median: 154, frames: 20, updates: 19, mutations: 19, nodes: 100_030 }), row({ points: 100_000, dense: '1', median: 33, frames: 90, updates: 10, mutations: 10, nodes: 402 })], []).join('\n')).toMatch(/only 10 appends completed; floor 20/)
  })
})
