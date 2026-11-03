// @vitest-environment node
/**
 * Every time unit puts the labels vega-lite 6.4.3 puts, in the zone America/New_York: both compiled specs run through the same vega in this
 * process, and every text they draw (axis, legend and header labels, text marks, as scene text and as SVG) and every tooltip and
 * description they compute must be the same. A UTC unit read in the viewer's zone, or a local one read in UTC, fails here. The
 * cases are in vl-timeunit-labels-cases.ts; one file per zone lets the zones run side by side.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FORMS, labelDifferences } from './vl-timeunit-labels-cases.js'

const ZONE = 'America/New_York'
let was: string | undefined
beforeAll(() => {
  was = process.env.TZ
  process.env.TZ = ZONE
})
afterAll(() => {
  if (was === undefined) delete process.env.TZ
  else process.env.TZ = was
})

describe(`time-unit labels in ${ZONE}`, () => {
  it('the zone takes effect', () => {
    expect(new Date('2020-07-01T00:00:00Z').getTimezoneOffset()).toBe(240)
  })
  for (const [formName, make] of FORMS) {
    it(formName, async () => {
      const bad = await labelDifferences(make)
      expect(bad.slice(0, 8), `${bad.length} units differ`).toEqual([])
    }, 120_000)
  }
})
