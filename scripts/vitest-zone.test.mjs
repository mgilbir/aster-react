/**
 * The default test run is pinned to a zone (docs/TESTING.md, "Time zones"): `vitest.config.mjs` sets TZ=UTC unless TZ is given,
 * so a machine in another zone runs what CI runs, and the tz-matrix gate's zones are kept (C379).
 */
import { expect, it } from 'vitest'

it('every worker runs in a zone named by TZ (UTC unless the run was given one)', () => {
  expect(process.env.TZ, 'vitest.config.mjs pins TZ').toBeTruthy()
  // the zone the dates use is the one TZ names
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(process.env.TZ === 'UTC' ? 'UTC' : process.env.TZ)
})
