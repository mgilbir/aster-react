// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { renderSpec } from './index.js'
import type { VgSpec } from './types.js'

/**
 * A format signal that calls `timeUnitSpecifier(...)` is evaluated by the expression engine; when the engine refuses it (an unknown
 * or clashing unit) the axis and the legend read the call's own text instead, with the units it can place. These pin what that
 * reads, so a change to the tables behind it (time.ts) cannot move it unseen.
 */
const axisLabels = (format: string): string[] => {
  const spec = {
    width: 300, height: 40, padding: 5,
    scales: [{ name: 'x', type: 'utc', domain: [Date.UTC(2020, 0, 1), Date.UTC(2020, 3, 1)], range: 'width' }],
    axes: [{ scale: 'x', orient: 'bottom', values: [Date.UTC(2020, 0, 1), Date.UTC(2020, 1, 15), Date.UTC(2020, 3, 1)], format: { signal: format } }],
  } as unknown as VgSpec
  const svg = renderSpec(spec, { logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never })
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!)
}

describe('timeUnitSpecifier format signals the engine refuses', () => {
  it('reads the units it knows when one is unknown, or the units clash', () => {
    expect(axisLabels('timeUnitSpecifier(["year","month"], {})')).toEqual(['2020-01', '2020-02', '2020-04'])
    expect(axisLabels('timeUnitSpecifier(["year","bogus"], {})')).toEqual(['2020', '2020', '2020'])
    expect(axisLabels('timeUnitSpecifier(["week","month"])')).toEqual(['Jan W00', 'Feb W06', 'Apr W13'])
    expect(axisLabels('timeUnitSpecifier(["hours","bogus"], {"hours": "%H h"})')).toEqual(['00 h', '00 h', '00 h'])
    expect(axisLabels('timeUnitSpecifier(["month","bogus","date"], {"month": "%b/", "date": "%e"})')).toEqual(['Jan/ 1', 'Feb/15', 'Apr/ 1'])
  })
})
