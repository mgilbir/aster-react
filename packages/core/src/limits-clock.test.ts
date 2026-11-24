// @vitest-environment node
/**
 * The clock (`maxTimeMs`) is read inside every pass over the rows, not only between them: a transform's pass is one synchronous
 * call, and a budget that is only compared after it lets the whole pass run (docs/LIMITS.md, "What maxTimeMs covers"). Each case
 * runs in a child process with a hard kill (attack.testkit.ts). Also see limits-attacks.test.ts for the attacks under each budget.
 */
import { describe, expect, it } from 'vitest'
import { SLACK_MS, attack, expectReturned } from './attack.testkit.js'

const T = 40_000

describe('every pass over the rows reads the clock inside it (C514, C340)', () => {
  // One case per transform (and the copy of the host's rows a dataset makes): its pass over the rows must read the clock as it
  // goes, by the name of the pass. The clock is VIRTUAL (each read advances it by one), so the budget is a count of reads and the
  // run is the same on any machine: the child runs each case once unbounded to count its reads, then once per budget from 0 to
  // that count (every read, or 200 budgets spread over them), and collects the phase each budget runs out in. A pass that does not read the clock never names it; the budget
  // then runs out at a checkpoint after it, having let the whole pass run. (Before C514 the copy of the rows, the sorts, the
  // per-row writes of bin/timeunit/identifier/lookup, formula, filter and the hierarchy walks read it nowhere: 1-2 s past a
  // 100 ms budget on 600 000 rows.)
  const geo = "projections: [{ name: 'p', type: 'mercator' }], "
  const CASES: Array<[name: string, transforms: string, phase: string, extra?: string, rows?: number]> = [
    ['the copy of the rows', '[]', 'dataset rows'],
    ['formula', "[{ type: 'formula', expr: 'datum.v * 2', as: 'w' }]", 'formula'],
    ['filter', "[{ type: 'filter', expr: 'datum.v >= 0' }]", 'filter'],
    ['collect sort', "[{ type: 'collect', sort: { field: ['x', 'k'] } }]", 'sort'],
    ['aggregate', "[{ type: 'aggregate', groupby: ['k'], fields: ['v'], ops: ['median'] }]", 'aggregate'],
    ['aggregate ci0 (bootstrap)', "[{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['ci0'] }]", 'bootstrap', '', 1000],
    ['joinaggregate', "[{ type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['mean'] }]", 'joinaggregate'],
    ['stack, grouped', "[{ type: 'stack', groupby: ['k'], field: 'v' }]", 'stack'],
    ['stack, sorted', "[{ type: 'stack', field: 'v', sort: { field: 'x' } }]", 'sort'],
    ['window rank', "[{ type: 'window', sort: { field: 'x' }, ops: ['rank'], as: ['r'] }]", 'sort'],
    ['window, grouped', "[{ type: 'window', groupby: ['g'], ops: ['row_number'], as: ['r'] }]", 'window'],
    ['lookup', "[{ type: 'lookup', from: 's', key: 'k', fields: ['k'], as: ['o'] }]", 'lookup', "{ name: 's', values: [{ k: 'k1' }] }, "],
    ['bin', "[{ type: 'bin', field: 'x', extent: [0, 1000], as: ['b0', 'b1'] }]", 'bin'],
    ['timeunit', "[{ type: 'timeunit', field: 'i', units: ['year', 'month'] }]", 'timeunit'],
    ['timeunit, units detected', "[{ type: 'timeunit', field: 'i' }]", 'timeunit'],
    ['extent', "[{ type: 'extent', field: 'x' }]", 'extent'],
    ['identifier', "[{ type: 'identifier', as: 'id' }]", 'identifier'],
    ['project', "[{ type: 'project', fields: ['x', 'v'] }]", 'project'],
    ['fold', "[{ type: 'fold', fields: ['x'] }]", 'fold'],
    ['flatten', "[{ type: 'flatten', fields: ['a'] }]", 'flatten'],
    ['pivot', "[{ type: 'pivot', field: 'v', value: 'x', groupby: ['g'] }]", 'pivot'],
    ['impute', "[{ type: 'impute', field: 'v', key: 'x', groupby: ['g'] }]", 'impute'],
    ['countpattern', "[{ type: 'countpattern', field: 's' }]", 'regular expression'],
    ['kde', "[{ type: 'kde', field: 'v' }]", 'kde'],
    ['quantile', "[{ type: 'quantile', field: 'v' }]", 'quantile'],
    ['regression', "[{ type: 'regression', x: 'x', y: 'v' }]", 'regression'],
    ['loess', "[{ type: 'loess', x: 'x', y: 'v', bandwidth: 0.01 }]", 'loess', '', 3000],
    ['sample', "[{ type: 'sample', size: 1000 }]", 'sample'],
    ['dotbin', "[{ type: 'dotbin', field: 'x' }]", 'dotbin'],
    ['pie', "[{ type: 'pie', field: 'v', sort: true }]", 'pie'],
    ['crossfilter', "[{ type: 'crossfilter', fields: ['x'], query: [[0, 500]] }]", 'crossfilter'],
    ['nest', "[{ type: 'nest', keys: ['g', 'x'] }]", 'nest'],
    ['stratify', "[{ type: 'stratify', key: 'i', parentKey: 'p' }]", 'stratify'],
    ['treemap', "[{ type: 'stratify', key: 'i', parentKey: 'p' }, { type: 'treemap', field: 'v', size: [500, 500] }]", 'hierarchy'],
    ['pack', "[{ type: 'nest', keys: ['g'] }, { type: 'pack', field: 'v', size: [500, 500] }]", 'pack'],
    ['voronoi', "[{ type: 'voronoi', x: 'x', y: 'v', size: [1000, 100] }]", 'voronoi'],
    ['force', "[{ type: 'force', static: true, iterations: 2, forces: [] }]", 'force'],
    ['geopoint', "[{ type: 'geopoint', projection: 'p', fields: ['x', 'v'] }]", 'geopoint', geo],
    ['linkpath', "[{ type: 'linkpath', sourceX: 'x', sourceY: 'v', targetX: 'v', targetY: 'x' }]", 'linkpath'],
  ]
  it.each(CASES)('%s', async (_name, transforms, phase, extra = '', n = 10_000) => {
    const r = await attack(`
      // 10 000 rows: about ten reads per pass at one read per 1024 rows
      const rows = Array.from({ length: ${n} }, (_, i) => ({ i, p: i === 0 ? null : (i - 1) >> 1, g: 'g' + (i % 100), k: 'k' + i, x: (i * 7919) % 1000, v: i % 97, s: 'abc' + (i % 50), a: [i, i + 1] }))
      const spec = { ${extra.startsWith('proj') ? extra : ''}data: [${extra.startsWith('{') ? extra : ''}{ name: 't', transform: ${transforms} }] }
      const realNow = performance.now
      let reads = 0
      performance.now = () => ++reads
      const run = (budget) => {
        reads = 0
        try { core.renderSpec(spec, { data: { t: rows }, limits: { maxTimeMs: budget } }); return null } catch (e) {
          const m = /maxTimeMs exceeded during (.*)$/.exec(e.message)
          if (!m) throw e
          return m[1]
        }
      }
      try {
        run(1e12)
        const total = reads
        const step = Math.max(1, Math.floor(total / 200))
        const phases = new Set()
        for (let b = 0; b < total; b += step) phases.add(run(b))
        return [...phases]
      } finally { performance.now = realNow }`)
    expectReturned(r)
    expect(r.value, `the phases the budget ran out in`).toContain(phase)
  }, T)
})

describe('a time budget stops a pass over many rows promptly (C514)', () => {
  // The cases the audit timed (1.5M rows, 100 ms: 1-2 s past the budget, and an out-of-memory crash for the stack here): a grouped
  // and sorted stack, a window rank and a collect sort. The rows are built before the clock starts and the CPU is measured around
  // the render only; the bound is the suite's own (2 x maxTimeMs + slack, attack.testkit.ts). (The copy of the rows and a
  // joinaggregate were 0.4-0.5 s past it, inside that slack: the phase test above is what pins their reads.)
  const BUDGET = 100
  it.each([
    ['stack, grouped and sorted', "[{ type: 'stack', groupby: ['k'], field: 'v', sort: { field: 'x' } }]"],
    ['window rank', "[{ type: 'window', sort: { field: 'x' }, ops: ['rank'], as: ['r'] }]"],
    ['collect sort', "[{ type: 'collect', sort: { field: ['x', 'k'] } }]"],
  ])('%s over 1 000 000 rows', async (_name, transforms) => {
    const r = await attack(`
      const rows = Array.from({ length: 1000000 }, (_, i) => ({ k: 'k' + i, x: (i * 7919) % 1000, v: i % 97, a: i, b: i, c: i, d: i, e: i }))
      const c0 = process.cpuUsage()
      let message = null
      try { core.renderSpec({ data: [{ name: 't', transform: ${transforms} }] }, { data: { t: rows }, limits: { maxTimeMs: ${BUDGET} } }) } catch (e) { message = String(e.message) }
      const c = process.cpuUsage(c0)
      return { message, cpuMs: (c.user + c.system) / 1000 }`)
    expectReturned(r)
    const { message, cpuMs } = r.value as { message: string | null; cpuMs: number }
    expect(message).toMatch(/maxTimeMs exceeded during /)
    expect(cpuMs, `${message} after ${cpuMs.toFixed(0)} ms of CPU`).toBeLessThan(2 * BUDGET + SLACK_MS)
  }, T)
})
