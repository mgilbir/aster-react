import { describe, it, expect } from 'vitest'
import { createChartSession } from '@aster-charts/core/dom'
import { drawsSame } from '@aster-charts/core/transition'
import { compile } from '@aster-charts/vl'

// The case a running transition is given most often: a Vega-Lite `time` animation's clock ticks 60 times a second, and between
// two of its frames nothing drawn changes. The transition keeps its plan only if those scenes compare as drawing the same
// (the marks are reused by the session, the guides are rebuilt with equal values).
describe('a Vega-Lite `time` animation between two frames', () => {
  it('draws the same at two clock ticks, and differently once the frame moves on', () => {
    const rows = [1990, 1991].flatMap((year) => Array.from({ length: 50 }, (_, i) => ({ year, x: i, y: (i * 7 + year) % 100 })))
    const spec = compile({
      width: 200, height: 100, data: { values: rows },
      params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['year'] } }],
      transform: [{ filter: { param: 'anim' } }], mark: 'point',
      encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' } },
    } as never) as never
    const session = createChartSession()
    const a = session.evaluate(spec, { signals: { anim_clock: 100 } })
    const b = session.evaluate(spec, { signals: { anim_clock: 116 } })
    expect(a).not.toBe(b)
    expect(drawsSame(a, b)).toBe(true)
    // the store holds the next frame: the filtered marks change
    const next = session.evaluate(spec, { signals: { anim_clock: 132 }, data: { anim_store: [{ unit: '', fields: [{ type: 'E', field: 'year' }], values: [1991] }] } })
    expect(drawsSame(b, next)).toBe(false)
  })
})
