// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { renderSpec } from './index.js'
import type { VgSpec } from './types.js'

/**
 * A format signal that calls `timeUnitSpecifier(...)` is evaluated by the expression engine. When the engine refuses it (an unknown or
 * clashing unit) the signal throws, as vega's does: the operator it is in vega (a parameter of the axis's ticks) fails, the error is
 * logged once, and the axis is not made -- vega 6.3.1 draws no label for any of these (differential-guide-format.test.mts compares
 * the general case with vega itself). These pin the messages and that nothing is read off the call's text instead.
 */
const axisOf = (format: string): { labels: string[]; errors: string[] } => {
  const spec = {
    width: 300, height: 40, padding: 5,
    scales: [{ name: 'x', type: 'utc', domain: [Date.UTC(2020, 0, 1), Date.UTC(2020, 3, 1)], range: 'width' }],
    axes: [{ scale: 'x', orient: 'bottom', values: [Date.UTC(2020, 0, 1), Date.UTC(2020, 1, 15), Date.UTC(2020, 3, 1)], format: { signal: format } }],
  } as unknown as VgSpec
  const errors: string[] = []
  const svg = renderSpec(spec, { logger: { error: (e: unknown) => { errors.push(String(e)) }, warn: () => {}, info: () => {}, debug: () => {} } as never })
  return { labels: [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!), errors }
}

describe('timeUnitSpecifier format signals the engine refuses', () => {
  it('formats with the units it is given', () => {
    expect(axisOf('timeUnitSpecifier(["year","month"], {})')).toEqual({ labels: ['2020-01', '2020-02', '2020-04'], errors: [] })
  })
  it('logs the refusal once and makes no axis when a unit is unknown, or the units clash (as vega)', () => {
    expect(axisOf('timeUnitSpecifier(["year","bogus"], {})')).toEqual({ labels: [], errors: ['Error: Invalid time unit: bogus.'] })
    expect(axisOf('timeUnitSpecifier(["week","month"])')).toEqual({ labels: [], errors: ['Error: Incompatible time units: week,month'] })
    expect(axisOf('timeUnitSpecifier(["hours","bogus"], {"hours": "%H h"})')).toEqual({ labels: [], errors: ['Error: Invalid time unit: bogus.'] })
    expect(axisOf('timeUnitSpecifier(["month","bogus","date"], {"month": "%b/", "date": "%e"})')).toEqual({ labels: [], errors: ['Error: Invalid time unit: bogus.'] })
  })
})
