import { describe, it, expect } from 'vitest'
import { AsterLimitError, checkSpecLimits, checkSceneLimits, checkSvgLength } from './limits.js'
import { renderSpec } from './index.js'

const base = {
  width: 100, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ c: 'a', v: 1 }, { c: 'b', v: 2 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: [0, 100] },
    { name: 'y', type: 'linear', domain: [0, 3], range: [100, 0] },
  ],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
    x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
    y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' },
  } } }],
}

describe('spec limits', () => {
  it('rejects rows, marks, strings and depth before rendering', () => {
    expect(() => checkSpecLimits(base as never, { maxRows: 1 })).toThrow(AsterLimitError)
    expect(() => checkSpecLimits(base as never, { maxMarks: 0 })).toThrow(/maxMarks/)
    expect(() => checkSpecLimits({ ...base, background: 'x'.repeat(20) } as never, { maxStringLength: 5 })).toThrow(/maxStringLength/)
    expect(() => checkSpecLimits(base as never, { maxDepth: 3 })).toThrow(/maxDepth/)
    expect(() => checkSpecLimits(base as never, { maxRows: 10, maxMarks: 10, maxDepth: 50 })).not.toThrow()
  })

  it('renderSpec enforces scene, path and SVG budgets with a typed error', () => {
    expect(() => renderSpec(base as never, { limits: { maxItems: 1 } })).toThrow(AsterLimitError)
    expect(() => renderSpec(base as never, { limits: { maxSvgLength: 20 } })).toThrow(/maxSvgLength/)
    const svg = renderSpec(base as never, { limits: { maxRows: 10, maxMarks: 10, maxItems: 1000, maxSvgLength: 100000 } })
    expect(svg).toContain('<svg')
  })

  it('checkSceneLimits/checkSvgLength report the exact budget', () => {
    expect(() => checkSceneLimits({ items: [{ path: 'M0,0L10,10' }] }, { maxPathLength: 3 })).toThrow(/maxPathLength 10 > 3/)
    expect(() => checkSvgLength('<svg/>', { maxSvgLength: 2 })).toThrow(/maxSvgLength 6 > 2/)
  })
})
