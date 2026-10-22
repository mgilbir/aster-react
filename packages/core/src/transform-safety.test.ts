// @vitest-environment node
/**
 * C8: non-terminating loops (bin maxbins <= 0, stratify cycles) must terminate
 * or throw exactly where vega does. C42: no Math.min/max(...array) (or push
 * spread) over data-sized arrays: 300k rows must not overflow the stack.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileChart, evaluateChart, applyTransforms, renderSpec } from './index.js'
import { buildStratifyTree } from './transform.js'
import { minOf, maxOf, pushAll } from './util.js'
import { attack } from './attack.testkit.js'
import type { VgSpec } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Oracle values recorded from the pinned vega 6.3.1 (vega-hierarchy / d3-hierarchy
 * stratify, vega-statistics bin) by running the specs below through `vega.View`
 * with a capturing logger (vega's dataflow swallows the throw and logs it). Core
 * tests may not import vega (pnpm check:deps), so they are replayed as constants.
 */
const VEGA_STRATIFY_ERRORS: Record<string, string | null> = {
  "cycle": "cycle",
  "self parent": "cycle",
  "multiple roots": "multiple roots",
  "missing parent": "missing: zzz",
  "ambiguous": "ambiguous: b",
  "no root": "no root",
  "empty": null
}

const VEGA_BIN_ROWS: Array<[Record<string, unknown>, string]> = [
  [
    {
      "maxbins": -1
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":null,\"b1\":null}]"
  ],
  [
    {
      "maxbins": 0
    },
    "[{\"x\":1,\"b0\":0,\"b1\":5},{\"x\":50,\"b0\":50,\"b1\":55},{\"x\":99,\"b0\":95,\"b1\":100}]"
  ],
  [
    {
      "maxbins": 0.5
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":null,\"b1\":null}]"
  ],
  [
    {
      "maxbins": 20
    },
    "[{\"x\":1,\"b0\":0,\"b1\":5},{\"x\":50,\"b0\":50,\"b1\":55},{\"x\":99,\"b0\":95,\"b1\":100}]"
  ],
  [
    {
      "maxbins": 3,
      "base": 1
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":null,\"b1\":null}]"
  ],
  [
    {
      "maxbins": 3,
      "base": 0.5
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":64,\"b1\":128}]"
  ],
  [
    {
      "maxbins": 3,
      "base": -2
    },
    "[{\"x\":1,\"b0\":null,\"b1\":null},{\"x\":50,\"b0\":null,\"b1\":null},{\"x\":99,\"b0\":null,\"b1\":null}]"
  ],
  [
    {
      "maxbins": 3,
      "base": 2
    },
    "[{\"x\":1,\"b0\":0,\"b1\":64},{\"x\":50,\"b0\":0,\"b1\":64},{\"x\":99,\"b0\":64,\"b1\":128}]"
  ]
]

describe('C8 stratify matches vega-hierarchy / d3-stratify', () => {
  const cases: Record<string, unknown[]> = {
    cycle: [{ id: 'a', p: 'b' }, { id: 'b', p: 'a' }, { id: 'r', p: null }],
    'self parent': [{ id: 'a', p: 'a' }, { id: 'r', p: null }],
    'multiple roots': [{ id: 'a', p: null }, { id: 'b', p: null }],
    'missing parent': [{ id: 'a', p: null }, { id: 'b', p: 'zzz' }],
    ambiguous: [{ id: 'a', p: null }, { id: 'b', p: 'a' }, { id: 'b', p: 'a' }, { id: 'c', p: 'b' }],
    'no root': [{ id: 'a', p: 'b' }, { id: 'b', p: 'a' }],
  }
  for (const [name, rows] of Object.entries(cases)) {
    it(`${name}: terminates and throws vega's error`, async () => {
      const oracle = VEGA_STRATIFY_ERRORS[name]
      expect(oracle, 'the oracle must reject this input').not.toBeNull()
      // run in a child with a hard kill: before the fix the cycle case never returned
      const r = await attack(`
        const rows = ${JSON.stringify(rows)}
        core.renderSpec({ data: [{ name: 't', values: rows, transform: [{ type: 'stratify', key: 'id', parentKey: 'p' }] }] })`)
      expect(r.killed, 'hang').toBe(false)
      expect(r.threw?.message).toBe(`[aster] stratify: ${oracle}`)
    }, 30_000)
  }

  it('stringifies ids like d3 (1 and "1" are the same node) and builds the same heights', () => {
    const root = buildStratifyTree([{ id: 1, p: null }, { id: 2, p: '1' }, { id: 3, p: 2 }], 'id', 'p')
    expect(root.height).toBe(2)
    expect(root.children[0]!.children[0]!.depth).toBe(2)
  })

  it('an empty source yields vega\'s placeholder root instead of an error', async () => {
    expect(VEGA_STRATIFY_ERRORS.empty).toBeNull()
    expect(() => buildStratifyTree([], 'id', 'p')).not.toThrow()
  })

  it('a 300k-deep chain does not overflow the stack (iterative walks)', () => {
    const n = 300_000
    const rows = Array.from({ length: n }, (_, i) => ({ id: i, p: i === 0 ? null : i - 1 }))
    expect(buildStratifyTree(rows, 'id', 'p').height).toBe(n - 1)
  })
})

describe('C8 bin follows vega-statistics bin()', () => {
  for (const [params, oracle] of VEGA_BIN_ROWS) {
    it(`${JSON.stringify(params)}: terminates with vega's rows`, async () => {
      const r = await attack(`
        const rows = core.applyTransforms([{ x: 1 }, { x: 50 }, { x: 99 }],
          [{ type: 'bin', field: 'x', extent: [1, 99], as: ['b0', 'b1'], ...${JSON.stringify(params)} }],
          { runtime: { expr() { throw new Error('no expressions') } }, signals: {} })
        return JSON.stringify(rows)`)
      expect(r.killed, 'hang').toBe(false)
      expect(r.threw).toBeNull()
      expect(r.value).toBe(oracle)
    }, 30_000)
  }

  it('a span so small the step underflows to 0 (vega spins forever) is an error', async () => {
    const r = await attack(`
      core.applyTransforms([{ x: 0 }, { x: 5e-324 }],
        [{ type: 'bin', field: 'x', extent: [0, 5e-324], maxbins: 20, as: ['b0', 'b1'] }],
        { runtime: { expr() { throw new Error('no expressions') } }, signals: {} })`)
    expect(r.killed, 'hang').toBe(false)
    expect(r.threw?.message).toMatch(/bin: cannot derive a step size/)
  }, 30_000)

  it('scale bins with a zero/NaN/negative step produce no bins instead of spinning', async () => {
    const r = await attack(`
      for (const step of [0, -1, NaN]) {
        core.renderSpec({ width: 100, height: 100, signals: [{ name: 'b', value: { start: 0, stop: 10, step } }],
          scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: [0, 100], bins: { signal: 'b' } }],
          axes: [{ orient: 'bottom', scale: 'x' }] })
      }`)
    expect(r.killed, 'hang').toBe(false)
  }, 30_000)
})

describe('C42: data-sized arrays never go through argument spread', () => {
  const N = 300_000
  const rows = Array.from({ length: N }, (_, i) => ({ x: i, y: (i * 7) % 1000, c: i % 5, t: 1.6e12 + i * 1000, g: 'g' + (i % 3) }))

  it('the helpers match Math.min/max(...a) on small inputs, including NaN, -0 and empty', () => {
    const samples: number[][] = [[], [3], [3, 1, 2], [NaN, 1], [1, NaN, 0], [-0, 0], [0, -0], [Infinity, -Infinity]]
    for (const a of samples) {
      expect(Object.is(minOf(a), Math.min(...a))).toBe(true)
      expect(Object.is(maxOf(a), Math.max(...a))).toBe(true)
    }
    const target = [1]
    pushAll(target, [2, 3])
    expect(target).toEqual([1, 2, 3])
  })

  it('the helpers survive 300k elements where the spread form overflows the stack', () => {
    const big = Array.from({ length: N }, (_, i) => i)
    expect(() => Math.max(...big)).toThrow(RangeError) // the hazard this guards against is real here
    expect(maxOf(big)).toBe(N - 1)
    expect(minOf(big)).toBe(0)
    const sink: number[] = []
    pushAll(sink, big)
    expect(sink.length).toBe(N)
  })

  it('the source has no Math.min/max(...x) or push(...x) left in packages/*/src (dom/canvas/hit excluded: other lanes)', () => {
    const root = join(here, '..', '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p) }
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.testkit\./.test(e.name) && !/^(dom|canvas|hit)\.ts$/.test(e.name)) {
          readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\*|\/\/|\/\*)/.test(line) || /\.\.\.args\b/.test(line)) return // comments; builtin argument lists
            if (/Math\.(min|max)\(\s*(0,\s*)?\.\.\./.test(line)) offenders.push(`${p}:${i + 1}`)
            // small, spec-bounded spreads: path tokens, a CSS selector split, vl cast lists
            else if (/\.(push|unshift)\(\s*\.\.\.[A-Za-z_]/.test(line) && !/\.\.\.(tok\.n|d\.casts|pre)\b|\.\.\.(\w+\.)?split\(/.test(line)) offenders.push(`${p}:${i + 1}`)
          })
        }
      }
    }
    for (const pkg of readdirSync(root)) walk(join(root, pkg, 'src'))
    expect(offenders).toEqual([])
  })

  const render = (spec: Record<string, unknown>) => evaluateChart(compileChart(spec as unknown as VgSpec), { data: { t: rows } })

  it('extent / aggregate min,max / impute min,max / bin / shared-kde domain over 300k rows', () => {
    const out = applyTransforms(rows as never, [
      { type: 'extent', field: 'x', signal: 'e' },
      { type: 'aggregate', groupby: ['g'], fields: ['x', 'x'], ops: ['min', 'max'], as: ['lo', 'hi'] },
    ] as never, { runtime: { expr() { throw new Error('x') } } as never, signals: {} } as never)
    expect(out).toHaveLength(3)
    expect(out[0]!.lo).toBe(0)
    const binned = applyTransforms(rows as never, [{ type: 'bin', field: 'x', maxbins: 10, as: ['b0', 'b1'] }] as never,
      { runtime: { expr() { throw new Error('x') } } as never, signals: {} } as never)
    expect(binned).toHaveLength(N)
    const imputed = applyTransforms(rows.map((r) => ({ ...r })) as never, [{ type: 'impute', field: 'y', key: 'x', method: 'max', groupby: ['g'], keyvals: [-1] }] as never,
      { runtime: { expr() { throw new Error('x') } } as never, signals: {} } as never)
    expect(imputed.length).toBeGreaterThan(N)
  })

  it('scale domains (linear, time, multi-field union, discrete) over 300k rows', () => {
    const scene = render({
      width: 200, height: 100, data: [{ name: 't' }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' },
        { name: 'u', type: 'linear', domain: { data: 't', fields: ['x', 'y'] }, range: 'height' },
        { name: 'tm', type: 'time', domain: { data: 't', field: 't' }, range: 'width' },
        { name: 'c', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' },
      ],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', value: 0 } } } }],
    })
    expect(scene).toBeTruthy()
  }, 60_000)

  it.each([{ orient: 'right', gridAlign: 'all' }, { orient: 'top', direction: 'horizontal', gridAlign: undefined }])(
    'a legend with 150k entries lays out (%j): legend entry maxima use no spread', (legend) => {
      const entries = Array.from({ length: 150_000 }, (_, i) => ({ x: 'v' + i }))
      const svg = renderSpec({
        width: 100, height: 100, data: [{ name: 't' }],
        scales: [{ name: 'c', type: 'ordinal', domain: { data: 't', field: 'x' }, range: 'category' }],
        legends: [{ fill: 'c', ...legend }],
      } as unknown as VgSpec, { data: { t: entries } })
      expect(svg.length).toBeGreaterThan(1000)
    }, 60_000)
})
