/**
 * LIVE differential for the scale classes (ADR-0001 suite formerly recorded as
 * `vega-scale.json`): the pinned `vega-scale` and Aster's port (`core/src/scale.ts`) run the
 * same op programs (`vega-scale-cases.mjs`) in ONE process and engine, and every result,
 * including NaN, -0, undefined and thrown errors (class and message), must be identical.
 * Nothing is recorded: pow/log/symlog and the colour interpolators go through Math.pow/exp/
 * log, which differ in the last bit between V8 versions (see `differential-util.mts`).
 *
 * Four groups: op programs (`scale`), the same under America/New_York (`scaleTz`, DST floors),
 * the scheme registry (`scheme`, continuous interpolators sampled at 21 points) and the tick
 * helpers (`vsticks`: tickCount, tickValues, bandSpace).
 */
import { describe, expect, it } from 'vitest'
import * as vegaScale from 'vega-scale'
import * as aster from '../../core/src/scale.ts'
import { exact, withTz } from './differential-util.mts'
import { scalePrograms, scaleTzPrograms, schemeNames, vstickCases } from './vega-scale-cases.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Api = {
  scale: (type: string) => any
  scheme: (name: string) => any
  tickCount: (s: any, count: any, minStep?: number) => any
  tickValues: (s: any, count?: any) => any
  bandSpace: (n: number, pi: number, po: number) => any
}
const vegaApi = vegaScale as unknown as Api
const asterApi = aster as unknown as Api

type Op = [string, ...unknown[]]

/** One result per op, in order; a throw is that op's result (the replay's `runScaleOps`). */
function runScaleOps(api: Api, type: string, dates: boolean, ops: Op[]): unknown[] {
  const s = api.scale(type)()
  const D = (v: unknown) => (dates && v != null ? new Date(v as number) : v)
  return ops.map(([name, ...args]) =>
    exact(() => {
      switch (name) {
        case 'domain':
          s.domain(dates ? (args[0] as number[]).map(D) : args[0])
          return s.domain()
        case 'range': s.range(args[0]); return s.range()
        case 'rangeRound': s.rangeRound(args[0]); return s.range()
        case 'clamp': return s.clamp(args[0])
        case 'unknown': return s.unknown(args[0])
        case 'nice': s.nice(args[0]); return s.domain()
        case 'base': return s.base(args[0])
        case 'exponent': return s.exponent(args[0])
        case 'constant': return s.constant(args[0])
        case 'round': return s.round(args[0])
        case 'padding': return s.padding(args[0])
        case 'paddingInner': return s.paddingInner(args[0])
        case 'paddingOuter': return s.paddingOuter(args[0])
        case 'align': return s.align(args[0])
        case 'invert': return s.invert(D(args[0]))
        case 'invertRange': return s.invertRange(args[0])
        case 'invertExtent': return s.invertExtent(args[0])
        case 'ticks': return s.ticks ? s.ticks(args[0] ?? undefined) : undefined
        case 'tickFormat': {
          const fmt = s.tickFormat(args[0] ?? undefined, args[1] ?? undefined)
          return (args.slice(2) as unknown[]).map((v) => fmt(D(v)))
        }
        case 'copy': {
          const c = s.copy()
          c.domain(args[0] !== undefined ? (dates ? (args[0] as number[]).map(D) : args[0]) : s.domain())
          return [c.domain(), s.domain(), c(s(args.length ? args[0] : undefined) === undefined ? null : s.domain()[0])]
        }
        case 'bandwidth': return s.bandwidth()
        case 'step': return s.step()
        case 'thresholds': return s.thresholds()
        case 'quantiles': return s.quantiles()
        case 'bins': s.bins = args[0]; return s.bins
        case 'call': return s(D(args[0]))
        default: throw new Error('unknown op ' + name)
      }
    }),
  )
}

function sampleScheme(api: Api, name: string): unknown {
  const s = api.scheme(name)
  if (Array.isArray(s)) return s
  if (typeof s === 'function') {
    const ts: unknown[] = []
    for (let i = 0; i <= 20; ++i) ts.push(s(i / 20))
    return ts
  }
  return s
}

type Vstick = (typeof vstickCases)[number] & Record<string, any>

function runVstick(api: Api, c: Vstick): unknown {
  const make = (dates: boolean) => {
    const s = api.scale(c.type)()
    s.domain(dates ? c.domain.map((v: number) => new Date(v)) : c.domain)
    return s
  }
  return exact(() => {
    switch (c.op) {
      case 'tickCount': {
        const s = make(false)
        if (c.bins) s.bins = c.bins
        return api.tickCount(s, c.count, c.minStep ?? undefined)
      }
      case 'tickValues': return api.tickValues(make(c.dates), c.count)
      case 'tickValuesInterval': {
        const s = make(c.dates)
        const count = c.step != null ? { interval: c.interval, step: c.step } : c.interval
        return api.tickValues(s, api.tickCount(s, count))
      }
      case 'bandSpace': return api.bandSpace(c.count, c.paddingInner, c.paddingOuter)
      default: throw new Error(`unsupported vsticks op "${c.op}"`)
    }
  })
}

describe(`vega-scale ${(vegaScale as { version?: string }).version ?? ''} vs Aster scale.ts (live)`, () => {
  scalePrograms.forEach(({ type, dates, ops }: { type: string; dates?: boolean; ops: Op[] }, i: number) => {
    it(`scale #${i} ${type}`, () =>
      withTz('UTC', () => {
        const want = runScaleOps(vegaApi, type, !!dates, ops)
        expect(runScaleOps(asterApi, type, !!dates, ops)).toEqual(want)
      }))
  })

  scaleTzPrograms.forEach(({ type, dates, ops }: { type: string; dates?: boolean; ops: Op[] }, i: number) => {
    it(`scaleTz #${i} ${type} (America/New_York)`, () =>
      withTz('America/New_York', () => {
        const want = runScaleOps(vegaApi, type, !!dates, ops)
        expect(runScaleOps(asterApi, type, !!dates, ops)).toEqual(want)
      }))
  })

  for (const name of schemeNames as string[]) {
    it(`scheme ${name}`, () =>
      withTz('UTC', () => {
        const want = exact(() => sampleScheme(vegaApi, name))
        expect(exact(() => sampleScheme(asterApi, name))).toEqual(want)
      }))
  }

  vstickCases.forEach((c: Vstick, i: number) => {
    it(`vsticks #${i} ${c.op} ${c.type ?? ''}`, () =>
      withTz('UTC', () => {
        const want = runVstick(vegaApi, c)
        expect(runVstick(asterApi, c)).toEqual(want)
      }))
  })

  it('keeps the recorded suite sizes (coverage floor)', () => {
    expect(scalePrograms.length).toBeGreaterThanOrEqual(43)
    expect(scaleTzPrograms.length).toBeGreaterThanOrEqual(2)
    expect(schemeNames.length).toBeGreaterThanOrEqual(68)
    expect(vstickCases.length).toBeGreaterThanOrEqual(60)
  })
})
