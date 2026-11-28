// @vitest-environment node
/**
 * Scale, tick and calendar work a tiny spec controls ends, with or without `limits` (C19, C96, C132): each spec here made the
 * process run out of memory or never return. Each runs in a child process with a hard kill (attack.testkit.ts) and must either
 * be refused with an AsterLimitError or finish, both within a bounded amount of CPU, with no limits, with a time budget alone,
 * and with an unrelated limit (a `limits` object must never be less safe than none).
 */
import { describe, it, expect } from 'vitest'
import { attack, expectLimit, type AttackResult } from './attack.testkit.js'

const T = 60_000
/** CPU a case may burn with no limits at all: the built-in ceilings stop it, or it ends by itself. */
const CPU_MS = 1500

const axis = (scale: Record<string, unknown>, axis: Record<string, unknown> = {}) => ({
  width: 300, height: 100, scales: [{ name: 'x', range: 'width', ...scale }], axes: [{ orient: 'bottom', scale: 'x', ...axis }],
})

/** Each limits setting a case runs under: none, a time budget alone, a limit that replaces no ceiling of these. */
const SETTINGS: Array<[string, unknown]> = [['no limits', undefined], ['maxTimeMs alone', { maxTimeMs: 300 }], ['maxMarks alone', { maxMarks: 1000 }]]

async function run(spec: unknown, limits: unknown): Promise<AttackResult> {
  return attack(`
    const errors = []
    const svg = core.renderSpec(${JSON.stringify(spec)}, { logger: { error: (e) => errors.push(String(e && e.message || e)), warn() {}, info() {}, debug() {} }${limits ? `, limits: ${JSON.stringify(limits)}` : ''} })
    return { errors, length: svg.length }`)
}

function expectEnded(r: AttackResult, cpuMs = CPU_MS): void {
  expect(r.killed, `child had to be killed (hang). stderr: ${r.stderr}`).toBe(false)
  expect(r.stderr, 'the child died').not.toMatch(/heap out of memory|FATAL/)
  expect(r.cpuMs, `cpu ${r.cpuMs} ms`).toBeLessThan(cpuMs)
}

/**
 * CPU a calendar sequence may burn before it is refused: its dates are counted against the `rows` ceiling (a million, as `sequence`'s
 * entries: a spec may legitimately ask for hundreds of thousands), and making a million Dates takes about a second.
 */
const SEQUENCE_CPU_MS = 8000

/** Specs that must be refused, by the ceiling named (or, under a time budget, by the clock). */
const REFUSED: Array<[string, unknown, RegExp, number?]> = [
  ['scale bins with a tiny step', axis({ type: 'linear', domain: [0, 1000], bins: { step: 1e-7 } }), /range/],
  ['utcSequence of seconds over 30 years', { signals: [{ name: 'n', update: "length(utcSequence('seconds', datetime(2000,0,1), datetime(2030,0,1)))" }] }, /time range|time ticks|time sequence/, SEQUENCE_CPU_MS],
  ['timeSequence of milliseconds over a year', { signals: [{ name: 'n', update: "length(timeSequence('milliseconds', datetime(2000,0,1), datetime(2001,0,1)))" }] }, /time range|time ticks|time sequence/, SEQUENCE_CPU_MS],
  ['log ticks of base 1e15 near a power', axis({ type: 'log', base: 1e15, domain: [9e14, 1e15] }), /log ticks/],
  ['log ticks of base 1e7 over 300 decades', axis({ type: 'log', base: 1e7, domain: [1, 1e300] }, { tickCount: 50 }), /log ticks/],
  ['log ticks of a negative domain, base 1e12', axis({ type: 'log', base: 1e12, domain: [-1e12, -1] }), /log ticks/],
  ['local week ticks stepped by 2e7', axis({ type: 'time', domain: [1.6e12, 1.7e12] }, { tickCount: { interval: 'week', step: 2e7 } }), /time interval search/],
  ['local week nice stepped by 2e7 before 1970', axis({ type: 'time', domain: [-1e12, -9e11], nice: { interval: 'week', step: 2e7 } }), /time interval search/],
  ['utcOffset of 4e6 quarters', { signals: [{ name: 'n', update: "utcOffset('quarter', datetime(2020,0,1), 4000000)" }] }, /time interval search/],
  ['timeOffset of -4e6 quarters', { signals: [{ name: 'n', update: "timeOffset('quarter', datetime(2020,0,1), -4000000)" }] }, /time interval search/],
  ['log ticks of base 1e6 inside one power (700 000 of them)', axis({ type: 'log', base: 1e6, domain: [2e5, 9e5] }), /log ticks/],
]

/** Specs that must simply finish (what vega would draw, or an Invalid Date where vega never returns). */
const FINISH: Array<[string, unknown]> = [
  ['utcOffset of 30 000 quarters', { signals: [{ name: 'n', update: "utcOffset('quarter', datetime(2020,0,1), 30000)" }] }],
  ['utc ticks at the last instant of the Date range', axis({ type: 'utc', domain: [8.64e15 - 60000, 8.64e15] })],
  ['utc ticks at the first instant of the Date range', axis({ type: 'utc', domain: [-8.64e15, -8.64e15 + 60000] })],
  ['utc week ticks stepped by 2e7', axis({ type: 'utc', domain: [1.6e12, 1.7e12] }, { tickCount: { interval: 'week', step: 2e7 } })],
  ['utc week nice stepped by 2e7 before 1970', axis({ type: 'utc', domain: [-1e12, -9e11], nice: { interval: 'week', step: 2e7 } })],
  ['time nice at the end of the Date range', axis({ type: 'time', domain: [8.64e15 - 40 * 864e5, 8.64e15 - 864e5], nice: true })],
  ['log ticks of base 1e6 near a power', axis({ type: 'log', base: 1e6, domain: [999990, 1e6] })],
]

describe('scale and calendar work a spec controls is bounded, with or without limits', () => {
  for (const [name, spec, ceiling, cpuMs] of REFUSED) {
    for (const [setting, limits] of SETTINGS) {
      it(`${name} is refused (${setting})`, async () => {
        const r = await run(spec, limits)
        expectEnded(r, cpuMs)
        expectLimit(r, limits && (limits as { maxTimeMs?: number }).maxTimeMs ? new RegExp(`${ceiling.source}|maxTimeMs`) : ceiling)
      }, T)
    }
  }
  for (const [name, spec] of FINISH) {
    for (const [setting, limits] of SETTINGS) {
      it(`${name} finishes (${setting})`, async () => {
        const r = await run(spec, limits)
        expectEnded(r)
        expect(r.threw, JSON.stringify(r.threw)).toBeNull()
      }, T)
    }
  }
})
