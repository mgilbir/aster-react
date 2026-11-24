/**
 * LIVE differential for "scale spec -> built scale". Each case is a Vega spec holding one
 * scale `s` (`scale-spec-cases.mjs`). It is built by real Vega (vega-parser + vega-encode's
 * Scale transform) and by Aster (`getChartInfo`), in the same process and engine, and the
 * two scales are projected identically (type, domain, range, sampled outputs, bins,
 * thresholds, ticks, invertExtent...) and compared exactly.
 *
 * A spec Vega refuses is compared by what the refusal says: its kind (`parse`: vega.parse throws, no view exists; `run`: an
 * operator fails while the view runs, and is logged) and its message. Aster reads a spec in one pass, so it either throws or
 * logs the error and goes on without the scale (docs/ERRORS.md: a parse-time refusal is logged, the chart is drawn without what
 * failed); both are the same refusal here, and the MESSAGE must be Vega's (one deliberate difference is named in `WORDED`). A
 * spec Vega builds must be built by Aster with nothing logged. See `differential-util.mts` for why nothing is recorded: pow,
 * log, symlog and the interpolators go through Math.pow/exp/log, which differ in the last bit between V8 versions (this suite
 * had three such failures on CI's Node 22 against Node 26 recordings).
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

/** What a refusal is: vega's kind of it and its message. */
interface Refusal { kind: 'parse' | 'run'; message: string }
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error: /, '')

/** The oracle: real Vega's scale `s`, or how Vega refuses the spec (an operator error is a refusal, not a half-configured scale). */
async function vegaScale(spec: unknown): Promise<{ scale: AnyScale } | { refusal: Refusal }> {
  let runtime: vega.Spec
  try {
    runtime = vega.parse(structuredClone(spec) as vega.Spec)
  } catch (e) {
    return { refusal: { kind: 'parse', message: text(e) } }
  }
  const errors: unknown[][] = []
  const quiet = quietLogger(errors)
  const view = new vega.View(runtime, { renderer: 'none', logLevel: vega.None, logger: quiet as never })
  view.logger(quiet as never)
  await view.runAsync()
  if (errors.length) return { refusal: { kind: 'run', message: text(errors[0]![0]) } }
  return { scale: view.scale('s') as unknown as AnyScale }
}

async function oracle(c: Case): Promise<{ want: unknown; refusal?: Refusal; probes: unknown[] }> {
  const built = await vegaScale(c.spec)
  if ('refusal' in built) return { want: { $: 'throw' }, refusal: built.refusal, probes: c.probes ?? [] }
  const probes = c.probes ?? autoProbes(built.scale)
  return { want: project(built.scale, probes), probes }
}

/** Where Aster words a refusal differently, on purpose: it quotes vega's message inside its own (`[aster] <what> (vega: <message>)`). */
const WORDED = (m: string): string => /^\[aster\] .*\(vega: (.*)\)$/s.exec(m)?.[1] ?? m

/** Aster's side: the projected scale, and the errors it threw or logged (a spec it refuses may also return no scale `s`). */
function aster(spec: unknown, probes: unknown[]): { got: unknown; thrown?: string; logged: string[] } {
  const logged: string[] = []
  const logger = { error: (...a: unknown[]) => { logged.push(text(a[0])) }, warn: () => {} }
  try {
    const s = getChartInfo(structuredClone(spec) as never, { logger } as never).scales.get('s') as AnyScale | undefined
    return { got: s ? project(s, probes) : { $: 'throw' }, logged }
  } catch (e) {
    return { got: { $: 'throw' }, thrown: text(e), logged }
  }
}

/** How the two sides refused, tallied: [vega kind, how Aster ended] -> cases. */
const tally = new Map<string, number>()

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
              const { want, refusal, probes } = await oracle(c)
              const a = aster(c.spec, probes)
              expect(a.got, `[${tz}]`).toEqual(want)
              if (!refusal) {
                // vega built the scale: Aster builds it and says nothing
                expect(a.thrown ?? a.logged[0], `[${tz}] Aster refused or logged where vega built the scale`).toBeUndefined()
                return
              }
              // vega refused: Aster refuses with vega's message, by throwing or by logging it (the chart then has no scale)
              const said = a.thrown ?? a.logged[0]
              expect(said === undefined ? said : WORDED(said), `[${tz}] Aster's refusal (vega ${refusal.kind}: ${refusal.message})`).toBe(refusal.message)
              const key = `${refusal.kind} -> ${a.thrown !== undefined ? 'throws' : 'logs'}`
              tally.set(key, (tally.get(key) ?? 0) + 1)
            })
          }
        })
      }
    })
  }
  it('a spec vega refuses is refused by Aster in the documented way: a parse refusal is thrown or logged, a run refusal likewise', () => {
    // (the tally is of the three zones together: every refusal is counted once per zone)
    const kinds = [...tally.keys()].sort()
    expect(kinds.every((k) => /^(parse|run) -> (throws|logs)$/.test(k)), kinds.join()).toBe(true)
    const total = [...tally.values()].reduce((n, v) => n + v, 0)
    expect(total, 'refusals compared').toBeGreaterThan(ZONES.length * 100)
    // most of what vega refuses at parse time Aster logs (ERRORS.md): if none were, the map above would say nothing
    expect(tally.get('parse -> logs') ?? 0).toBeGreaterThan(ZONES.length * 20)
  })

  it('covers the whole case list', () => {
    expect(Object.values(suites).reduce((n, l) => n + l.length, 0)).toBeGreaterThanOrEqual(2478)
  })
})
