import { describe, it, expect } from 'vitest'
import { parseProbeArgs, probeVerdict } from './probe-verdict.js'

describe('probe verdict', () => {
  it('passes at the floor and above, and when a failing probe documents a gap above the floor', () => {
    expect(probeVerdict(2, 2, 2).ok).toBe(true)
    expect(probeVerdict(2, 3, 2).ok).toBe(true)
    expect(probeVerdict(5, 5, 2).ok).toBe(true)
  })

  it('FAILS when a probe that passed stops passing', () => {
    const v = probeVerdict(1, 2, 2)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('1 probe(s) pass, the floor is 2')
  })

  it('FAILS when the probes are gone (nothing found is not a pass)', () => {
    expect(probeVerdict(0, 0, 2)).toEqual({ ok: false, reason: 'only 0 probe(s) found, the floor is 2 passing' })
  })

  it('is diagnostic only without a floor', () => {
    expect(probeVerdict(0, 3, null).ok).toBe(true)
  })

  it('reads the filter and the floor from the command line, and refuses a malformed floor', () => {
    expect(parseProbeArgs(['--', '--min-pass', '2'])).toEqual({ filter: undefined, minPass: 2 })
    expect(parseProbeArgs(['geo', '--min-pass=1'])).toEqual({ filter: 'geo', minPass: 1 })
    expect(() => parseProbeArgs(['--min-pass'])).toThrow(/non-negative integer/)
    expect(() => parseProbeArgs(['--min-pass', 'x'])).toThrow(/non-negative integer/)
    expect(() => parseProbeArgs(['--frobnicate'])).toThrow(/unknown option/)
  })
})
