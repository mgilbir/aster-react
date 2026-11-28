/**
 * Calendar of axis/legend labels: a UTC scale formats its labels in
 * UTC whatever the viewer's zone, a time scale in local time. Expected strings
 * were recorded from real vega (6.3.1) and are the same under every zone for the
 * UTC cases; the local-time case is derived from the zone the runner asked for.
 *
 * Run under several zones with `pnpm test:tz` (the repo used to run only under
 * TZ=UTC, which hides every zone-dependent bug). A run that names no zone is
 * pinned to UTC, so a laptop in any zone passes; `pnpm test:tz` names its zones
 * (scripts/lib/tz-zones.mjs) and each of them has a recorded table below. A zone
 * with no recorded table fails: it would otherwise pass checking nothing.
 * The tables are what `packages/conformance/scripts/gen-tz-hours.mjs` records.
 */
import { describe, expect, it } from 'vitest'
import { renderSpec } from './index.js'
import { ZONES } from '../../../scripts/lib/tz-zones.mjs'

process.env.TZ ??= 'UTC'

const H = 3600000
const D = 86400000
const JAN1_2024 = 1704067200000

function texts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!)
}

const base = { width: 400, height: 100, padding: 5, autosize: 'none' }

function axisLabels(scale: Record<string, unknown>, axis: Record<string, unknown> = {}): string[] {
  const svg = renderSpec({
    ...base,
    scales: [{ name: 'x', range: 'width', ...scale }],
    axes: [{ scale: 'x', orient: 'bottom', ...axis }],
  } as never)
  return texts(svg)
}

/** getTimezoneOffset() at the epoch (minutes) of the zones `pnpm test:tz` runs under. */
const EPOCH_OFFSET: Record<string, number> = { UTC: 0, 'America/New_York': 300, 'Asia/Kolkata': -330, 'Australia/Lord_Howe': -600 }

describe('time zone of the test run', () => {
  it('honours the zone the runner asked for', () => {
    const asked = process.env.TZ
    expect(asked, 'a zone this file has no record of').toBeDefined()
    expect(Object.keys(EPOCH_OFFSET)).toContain(asked)
    expect(new Date(0).getTimezoneOffset()).toBe(EPOCH_OFFSET[asked!])
  })
})

describe('UTC scales format in UTC', () => {
  it('hour ticks', () => {
    expect(axisLabels({ type: 'utc', domain: [0, 6 * H] })).toEqual(
      ['1970', '12:30', '01 AM', '01:30', '02 AM', '02:30', '03 AM', '03:30', '04 AM', '04:30', '05 AM', '05:30', '06 AM'],
    )
  })

  it('day ticks across a month boundary', () => {
    expect(axisLabels({ type: 'utc', domain: [JAN1_2024 - 3 * D, JAN1_2024 + 40 * D] })).toEqual(
      ['Dec 31', 'Jan 07', 'Jan 14', 'Jan 21', 'Jan 28', 'Feb 04'],
    )
  })

  it('an explicit format specifier', () => {
    expect(axisLabels({ type: 'utc', domain: [JAN1_2024, JAN1_2024 + 3 * D] }, { format: '%Y-%m-%d %H:%M', tickCount: 3 })).toEqual(
      ['2024-01-01 00:00', '2024-01-02 00:00', '2024-01-03 00:00', '2024-01-04 00:00'],
    )
  })

  it('formatType utc on a numeric scale', () => {
    expect(
      axisLabels({ type: 'linear', zero: false, domain: [JAN1_2024, JAN1_2024 + 3 * D] }, { format: '%Y-%m-%d %H:%M', formatType: 'utc', tickCount: 3 }),
    ).toEqual(['2024-01-01 09:06', '2024-01-02 12:53', '2024-01-03 16:40'])
  })

  it('a legend over dates formats with formatType utc', () => {
    const svg = renderSpec({
      width: 200, height: 100, padding: 5, autosize: 'none',
      data: [{ name: 'd', values: [{ t: '2024-01-01T23:30:00Z' }, { t: '2024-03-10T01:15:00Z' }], format: { parse: { t: 'date' } } }],
      scales: [{ name: 'c', type: 'ordinal', domain: { data: 'd', field: 't' }, range: { scheme: 'category10' } }],
      legends: [{ fill: 'c', type: 'symbol', format: '%Y-%m-%d %H:%M', formatType: 'utc' }],
    } as never)
    expect(texts(svg)).toEqual(['2024-01-01 23:30', '2024-03-10 01:15'])
  })
})

/** What real vega draws for a time scale over [0, 6h] in each zone (recorded from vega 6.3.1). */
const LOCAL_HOURS: Record<string, string[]> = {
  UTC: ['1970', '12:30', '01 AM', '01:30', '02 AM', '02:30', '03 AM', '03:30', '04 AM', '04:30', '05 AM', '05:30', '06 AM'],
  'America/New_York': ['07 PM', '07:30', '08 PM', '08:30', '09 PM', '09:30', '10 PM', '10:30', '11 PM', '11:30', '1970', '12:30', '01 AM'],
  'Asia/Kolkata': ['05:30', '06 AM', '06:30', '07 AM', '07:30', '08 AM', '08:30', '09 AM', '09:30', '10 AM', '10:30', '11 AM', '11:30'],
  'Australia/Lord_Howe': ['10 AM', '10:30', '11 AM', '11:30', '12 PM', '12:30', '01 PM', '01:30', '02 PM', '02:30', '03 PM', '03:30', '04 PM'],
}

describe('time scales format in the local zone', () => {
  const zone = process.env.TZ ?? 'UTC'
  it(`hour ticks in ${zone}`, () => {
    expect(Object.keys(LOCAL_HOURS), 'a zone this file has no record of').toContain(zone)
    expect(axisLabels({ type: 'time', domain: [0, 6 * H] })).toEqual(LOCAL_HOURS[zone])
  })
  it('the recorded zones are the zones pnpm test:tz runs, and UTC (the default run)', () => {
    expect(Object.keys(LOCAL_HOURS)).toEqual(['UTC', ...ZONES])
    expect(Object.keys(EPOCH_OFFSET)).toEqual(['UTC', ...ZONES])
  })
})
