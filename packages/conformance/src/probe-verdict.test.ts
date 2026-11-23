import { describe, it, expect } from 'vitest'
import { parseProbeArgs } from './probe-verdict.js'

// The verdict (a floor on the probes compared, nothing found fails, a listed gap must still fail) is runGate's:
// scripts/run-gate.test.mjs.
describe('probe command line', () => {
  it('reads the filter and the floor from the command line, and refuses a malformed floor', () => {
    expect(parseProbeArgs(['--', '--min-pass', '2'])).toEqual({ filter: undefined, minPass: 2 })
    expect(parseProbeArgs(['geo', '--min-pass=1'])).toEqual({ filter: 'geo', minPass: 1 })
    expect(() => parseProbeArgs(['--min-pass'])).toThrow(/non-negative integer/)
    expect(() => parseProbeArgs(['--min-pass', 'x'])).toThrow(/non-negative integer/)
    expect(() => parseProbeArgs(['--frobnicate'])).toThrow(/unknown option/)
  })
})
