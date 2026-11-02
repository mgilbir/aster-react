import { describe, it, expect } from 'vitest'
import { checkBrowserBench, checkStreamBench, type BrowserResults, type DifferentialStages, type StreamRow } from './browser-floors.js'

const S = (median: number): { median: number; p95: number } => ({ median, p95: median * 1.3 })
const embeds = (aster: number, vega: number): Record<string, unknown> => ({ aster: S(aster), asterDom: S(aster), reactVega: S(vega), embedHook: S(vega * 0.9) })

/** A run shaped like a measured one (line @ 1000 points). */
function good(): { results: BrowserResults; diff: DifferentialStages } {
  const frames = { median: 16.7, p95: 17.3, longShare: 0, frames: 178 }
  return {
    results: {
      'mount:line': embeds(2.4, 3.4),
      'update:line': embeds(2.9, 3.5),
      'fps:line': { aster: frames, asterDom: frames, reactVega: frames, embedHook: frames },
      'autoResize:line': { aster: { lags: [17, 17, 17, 17], median: 17, resized: 4, total: 4 }, asterDom: { lags: [17, 17, 17, 17], median: 17, resized: 4, total: 4 } },
      'stable:line': { aster: { ms: S(0.3), mutations: [0, 0, 0] }, asterDom: { ms: S(0.4), mutations: [0, 0, 0] } },
    },
    diff: { fullEval: [0.3, 0.3, 0.3], fullPatch: [0.8, 0.8, 0.8], diffEval: [0.1, 0.1, 0.1], diffPatch: [0.1, 0.1, 0.1] },
  }
}

describe('checkBrowserBench', () => {
  it('passes a run like a measured one', () => {
    const { results, diff } = good()
    expect(checkBrowserBench(results, ['line'], [], diff)).toEqual([])
  })

  it('FAILS when aster is slower than the Vega embeds by more than the floor (update and first render)', () => {
    const a = good(); a.results['update:line'] = embeds(9, 3.5)
    expect(checkBrowserBench(a.results, ['line'], [], a.diff).join('\n')).toMatch(/aster update is 2\.57x the slower Vega embed/)
    const b = good(); b.results['mount:line'] = embeds(9, 3.5)
    expect(checkBrowserBench(b.results, ['line'], [], b.diff).join('\n')).toMatch(/aster mount is/)
  })

  it('FAILS when an identical-content re-render writes to the DOM', () => {
    const g = good(); g.results['stable:line'] = { aster: { ms: S(1), mutations: [0, 3, 0] }, asterDom: { ms: S(1), mutations: [0] } }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff).join('\n')).toMatch(/aster wrote to the DOM on an identical-content re-render/)
  })

  it('FAILS when the chart does not follow its container (the 0/4 the old harness printed and nobody read)', () => {
    const g = good(); g.results['autoResize:line'] = { aster: { lags: [-1, -1, -1, -1], median: NaN, resized: 0, total: 4 }, asterDom: { lags: [17, 17, 17, 17], median: 17, resized: 4, total: 4 } }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff).join('\n')).toMatch(/aster followed 0 of 4 container resizes/)
    delete g.results['autoResize:line']
    expect(checkBrowserBench(g.results, ['line'], [], g.diff).join('\n')).toMatch(/aster has no container-resize measurement/)
  })

  it('FAILS when frames are dropped, none were painted, or the page threw', () => {
    const g = good(); g.results['fps:line'] = { aster: { median: 40, p95: 90, longShare: 0.6, frames: 100 }, asterDom: { median: 16.7, p95: 17, longShare: 0, frames: 0 } }
    const text = checkBrowserBench(g.results, ['line'], ['boom'], g.diff).join('\n')
    expect(text).toMatch(/aster drops 60\.0% of its frames/)
    expect(text).toMatch(/asterDom painted no frames/)
    expect(text).toMatch(/the benchmark page threw: boom/)
  })

  it('FAILS when the differential update is not cheaper than a full re-encode', () => {
    const g = good(); g.diff = { fullEval: [0.3], fullPatch: [0.8], diffEval: [0.3], diffPatch: [0.7] }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff).join('\n')).toMatch(/differential update is 1\.1x cheaper/)
  })

  it('FAILS on a run that measured nothing: no kinds, no aster timings, no Vega timings to compare with', () => {
    expect(checkBrowserBench({}, [], [])).toEqual(['no chart kind was measured'])
    expect(checkBrowserBench({}, ['line'], []).join('\n')).toMatch(/aster produced no update timings/)
    const g = good(); g.results['update:line'] = { aster: S(2.9) }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff).join('\n')).toMatch(/the Vega embeds produced no update timings/)
  })

  it('FAILS on a leaking heap when it is measured', () => {
    const g = good(); g.results['heap:line'] = { aster: { retainedMB: 80 } }
    expect(checkBrowserBench(g.results, ['line'], [], g.diff).join('\n')).toMatch(/aster retains 80\.0 MB/)
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
})
