/**
 * LIVE differential for "scale spec -> built scale". Each case is a Vega spec holding one
 * scale `s` (`scale-spec-cases.mjs`). It is built by real Vega (vega-parser + vega-encode's
 * Scale transform) and by Aster (`getChartInfo`), in the same process and engine, and the
 * two scales are projected identically (type, domain, range, sampled outputs, bins,
 * thresholds, ticks, invertExtent...) and compared exactly. A spec Vega rejects must throw
 * in Aster too. See `differential-util.mts` for why nothing is recorded: pow, log, symlog and
 * the interpolators go through Math.pow/exp/log, which differ in the last bit between V8
 * versions (this suite had three such failures on CI's Node 22 against Node 26 recordings).
 *
 * Every case runs under UTC and under the non-UTC zones below: the scales under test are
 * UTC or numeric (they must not move with the zone), and local-time (`time`) scales must
 * follow the process zone exactly as Vega's do. `scripts/test-tz.mjs` (the `tz-matrix` gate)
 * additionally starts the whole process in each zone.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { getChartInfo } from '../../core/src/runtime.ts'
import { attempt, quietLogger, withTz } from './differential-util.mts'
import { suites } from './scale-spec-cases.mjs'

const ZONES = ['UTC', 'America/New_York', 'Asia/Kolkata']
const OFFSETS: Record<string, number> = { UTC: 0, 'America/New_York': 300, 'Asia/Kolkata': -330 }

type AnyScale = ((x: unknown) => unknown) & Record<string, unknown>
type Case = { name: string; spec: unknown; probes?: unknown[] }

/** Probe inputs derived from the oracle scale, fed to both sides. */
function autoProbes(s: AnyScale): unknown[] {
  const d = ((s.domain as (() => unknown[]) | undefined)?.() ?? []) as unknown[]
  const out: unknown[] = []
  const nums = d.map((x) => (x instanceof Date ? x.getTime() : x))
  if (nums.length && nums.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    const n = nums as number[]
    const lo = n[0]!
    const hi = n[n.length - 1]!
    const span = hi - lo
    const stops = [...n]
    for (const f of [-0.5, 0.1, 0.25, 0.5, 0.75, 0.9, 1.5]) stops.push(lo + span * f)
    // between consecutive stops of a piecewise domain too
    for (let i = 0; i + 1 < n.length; i++) stops.push((n[i]! + n[i + 1]!) / 2)
    out.push(...stops, 0, 1, NaN, null, undefined)
  } else if (Array.isArray(d)) {
    out.push(...d.slice(0, 12), '__unknown__', null, undefined)
  }
  return out
}

function project(s: AnyScale, probes: unknown[]): Record<string, unknown> {
  const m = (name: string, ...args: unknown[]): unknown => (s[name] as (...a: unknown[]) => unknown)(...args)
  const o: Record<string, unknown> = {}
  o.type = s.type
  o.domain = attempt(() => m('domain'))
  o.range = attempt(() => (typeof s.range === 'function' ? m('range') : undefined))
  o.samples = probes.map((p) => attempt(() => s(p)))
  for (const name of ['bandwidth', 'step', 'thresholds', 'quantiles', 'clamp', 'round', 'exponent', 'base', 'constant', 'padding', 'paddingInner', 'paddingOuter', 'align', 'unknown']) {
    if (typeof s[name] === 'function') o[name] = attempt(() => (name === 'quantiles' ? m('quantiles', 4) : m(name)))
  }
  o.bins = 'bins' in s ? attempt(() => s.bins) : { $: 'undef' }
  if (typeof s.ticks === 'function') o.ticks = attempt(() => m('ticks', 5))
  if (typeof s.invertExtent === 'function') {
    const r = (() => { try { return m('range') } catch { return [] } })()
    if (Array.isArray(r)) o.invertExtent = r.slice(0, 12).map((x) => attempt(() => m('invertExtent', x)))
  }
  return o
}

/** The oracle: real Vega's scale `s` (an operator error is a THROW, not a half-configured scale). */
async function vegaScale(spec: unknown): Promise<AnyScale> {
  const errors: unknown[][] = []
  const quiet = quietLogger(errors)
  const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logLevel: vega.None, logger: quiet as never })
  view.logger(quiet as never)
  await view.runAsync()
  if (errors.length) throw new Error(String(errors[0]))
  return view.scale('s') as unknown as AnyScale
}

async function oracle(c: Case): Promise<{ want: unknown; probes: unknown[] }> {
  try {
    const s = await vegaScale(c.spec)
    const probes = c.probes ?? autoProbes(s)
    return { want: project(s, probes), probes }
  } catch {
    return { want: { $: 'throw' }, probes: c.probes ?? [] }
  }
}

function aster(spec: unknown, probes: unknown[]): unknown {
  try {
    const s = getChartInfo(structuredClone(spec) as never).scales.get('s') as AnyScale | undefined
    return s ? project(s, probes) : { $: 'throw' }
  } catch {
    return { $: 'throw' }
  }
}

describe(`scale specs vs vega@${vega.version} (live, every zone: ${ZONES.join(', ')})`, () => {
  for (const tz of ZONES) {
    it(`runs in the zone it asked for: ${tz}`, async () => {
      await withTz(tz, () => expect(new Date(0).getTimezoneOffset()).toBe(OFFSETS[tz]))
    })
  }
  for (const [suite, cases] of Object.entries(suites) as [string, Case[]][]) {
    describe(suite, () => {
      for (const c of cases) {
        it(c.name, async () => {
          for (const tz of ZONES) {
            await withTz(tz, async () => {
              const { want, probes } = await oracle(c)
              expect(aster(c.spec, probes), `[${tz}]`).toEqual(want)
            })
          }
        })
      }
    })
  }
  it('covers the whole case list', () => {
    expect(Object.values(suites).reduce((n, l) => n + l.length, 0)).toBeGreaterThanOrEqual(1838)
  })
})
