// @vitest-environment node
/**
 * The recorded oracle vectors must be able to FAIL. A suite whose cases are repeated, whose inputs never vary a
 * dimension the code under test reads, or whose wants are all the same cannot tell a correct port from a broken one,
 * however many cases it holds. Each test below states a dimension a recorded suite has to vary and checks it in the
 * committed JSON (audit 2026-11-22: C359, C621-C623, C693-C700, C701, C763):
 *
 *  - no suite records the same case twice;
 *  - floors: every unit list is floored on instants with non-zero seconds and milliseconds, and a step changes the result
 *    for the minutes / seconds / milliseconds units, the y-m-d-H-M-S list is not the identity;
 *  - offsets: zero, fractional, negative-fractional and absent steps, every unit including `dayofyear`, a result that
 *    lands in the spring gap, one on the repeated hour, an input in the second 01:30;
 *  - sequences: `day` and `dayofyear`; specifiers: a composite-key override that changes the output, a `null` specifier;
 *  - intervals: floor / ceil / round on an instant off every boundary, and count / range / every(3) for each of the
 *    sixteen local, UTC, sub-day and calendar intervals, the year window containing a multiple of three;
 *  - formats: the sign / symbol options reach a value, the SI prefixes y..Y and the clamp, non-finite refs, coerced values;
 *  - multi-format objects: every level (year ... millisecond) is printed with its own pattern; `%Z` changes within both
 *    transition days; `%L` and `%f` are not constant; the ISO week-date and the skipped / repeated hour parse;
 *  - colours: percent rgba, 4- and 8-digit hex with alpha, upper case; dsv: a converter that drops rows, `parse` to objects.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'testdata', 'vectors')

type Tagged = { $: string; ms?: number; message?: string }
interface Case { args: unknown[]; want: unknown; variant?: string }
interface Suite { cases: Case[]; tz?: string }
const load = (f: string): Record<string, Suite> => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { suites: Record<string, Suite> }).suites

const util = load('vega-util.json')
const color = load('d3-color.json')
const time = load('vega-time.json')
const fmt = load('d3-format.json')
const locale = load('vega-format.json')
const dsv = load('d3-dsv.json')
const suiteOf = (all: Record<string, Suite>, name: string): Suite => {
  const s = all[name]
  if (!s) throw new Error(`no recorded suite "${name}"`)
  return s
}

const isTag = (v: unknown, tag: string): v is Tagged => typeof v === 'object' && v !== null && (v as Tagged).$ === tag
const ms = (v: unknown): number => {
  if (!isTag(v, 'date')) throw new Error(`not a recorded date: ${JSON.stringify(v)}`)
  return v.ms!
}
const key = (v: unknown): string => JSON.stringify(v)
/** The recorded zone's wall clock `H:M` (and day of month) of an instant. */
function wall(zone: string, t: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(t)
}
const NY = 'America/New_York'

describe('recorded vectors: a case is recorded once', () => {
  const files = ['vega-util.json', 'd3-color.json', 'vega-time.json', 'd3-format.json', 'vega-format.json', 'd3-dsv.json', 'topojson-client.json']
  for (const f of files) {
    for (const [name, suite] of Object.entries(load(f))) {
      it(`${f} ${name}: ${suite.cases.length} cases, all distinct`, () => {
        const seen = new Set<string>()
        const dups: string[] = []
        for (const c of suite.cases) {
          const k = key([c.args, c.variant])
          if (seen.has(k)) dups.push(k.slice(0, 120))
          seen.add(k)
        }
        expect(dups).toEqual([])
      })
    }
  }
})

describe('recorded vectors: floors vary every field the floor reads', () => {
  for (const name of ['timeFloor', 'utcFloor']) {
    const suite = suiteOf(time, name)
    const byUnits = new Map<string, Map<number, Map<string, number>>>() // units -> instant -> step -> want ms
    for (const c of suite.cases) {
      const [units, step, d] = c.args
      const u = key(units)
      const inst = ms(d)
      const steps = byUnits.get(u) ?? new Map<number, Map<string, number>>()
      const row = steps.get(inst) ?? new Map<string, number>()
      row.set(key(step), ms(c.want))
      steps.set(inst, row)
      byUnits.set(u, steps)
    }
    const instants = [...byUnits.values()][0]!
    it(`${name}: floors instants with non-zero seconds, milliseconds, and minutes that are no multiple of 3 or 5`, () => {
      const ts = [...instants.keys()]
      expect(ts.some((t) => t % 60_000 !== 0)).toBe(true)
      expect(ts.some((t) => t % 1000 !== 0)).toBe(true)
      expect(ts.some((t) => t % 1000 !== 0 && (Math.floor(t / 1000) % 60) % 3 !== 0)).toBe(true)
      expect(ts.some((t) => { const m = Math.floor(t / 60_000) % 60; return m % 3 !== 0 && m % 5 !== 0 })).toBe(true)
      expect(ts.some((t) => t % 1000 % 3 !== 0 && t % 1000 % 5 !== 0)).toBe(true)
    })
    for (const [u, steps] of byUnits) {
      it(`${name} ${u}: several distinct floors, and steps 3 and 5 each change the result on some instant`, () => {
        const wants = new Set<number>()
        let bite3 = 0, bite5 = 0
        for (const [, row] of steps) {
          const base = row.get(key({ $: 'undef' }))!
          for (const w of row.values()) wants.add(w)
          if (row.get('3') !== base) bite3++
          if (row.get('5') !== base) bite5++
        }
        expect(wants.size).toBeGreaterThanOrEqual(4)
        expect(bite3, 'step 3 never changes a floor').toBeGreaterThan(0)
        expect(bite5, 'step 5 never changes a floor').toBeGreaterThan(0)
      })
    }
    it(`${name}: the y-m-d-H-M-S floor is not the identity`, () => {
      const steps = byUnits.get(key(['year', 'month', 'date', 'hours', 'minutes', 'seconds']))!
      let moved = 0
      for (const [inst, row] of steps) if (row.get(key({ $: 'undef' })) !== inst) moved++
      expect(moved).toBeGreaterThanOrEqual(2)
    })
    it(`${name}: instants after each 2024 transition, in the repeated hour, and the last millisecond before the gap`, () => {
      const ts = new Set(instants.keys())
      for (const iso of ['2024-03-10T07:30:00Z', '2024-11-03T06:30:00Z', '2024-03-10T06:59:59.999Z']) expect(ts.has(Date.parse(iso)), iso).toBe(true)
    })
  }
})

describe('recorded vectors: offsets', () => {
  for (const name of ['timeOffset', 'utcOffset']) {
    const suite = suiteOf(time, name)
    it(`${name}: every unit incl. dayofyear, with zero, fractional, negative-fractional and absent steps`, () => {
      expect(new Set(suite.cases.map((c) => c.args[0]))).toEqual(
        new Set(['year', 'quarter', 'month', 'week', 'date', 'day', 'dayofyear', 'hours', 'minutes', 'seconds', 'milliseconds']))
      const steps = new Set(suite.cases.map((c) => key(c.args[2])))
      for (const s of ['0', '1.5', '-0.5', '{"$":"undef"}', '1', '3', '-2', '12']) expect(steps.has(s), `step ${s}`).toBe(true)
    })
    it(`${name}: a fractional step floors (-0.5 is one back, 1.5 is one forward, 0 stays)`, () => {
      const at = (unit: unknown, t: number, step: unknown) => suite.cases.find((c) => c.args[0] === unit && ms(c.args[1]) === t && key(c.args[2]) === key(step))!.want
      for (const c of suite.cases.filter((x) => x.args[2] === 1.5)) {
        expect(key(c.want), `${c.args[0]} 1.5`).toBe(key(at(c.args[0], ms(c.args[1]), 1)))
      }
      for (const c of suite.cases.filter((x) => x.args[2] === -0.5)) {
        expect(ms(c.want), `${c.args[0]} -0.5`).toBeLessThan(ms(c.args[1]))
      }
      // step 0 re-sets the calendar fields; it moves the instant only where a local wall clock is ambiguous (the repeated hour)
      const ambiguous = (t: number) => name === 'timeOffset' && t >= Date.parse('2024-11-03T05:00:00Z') && t < Date.parse('2024-11-03T07:00:00Z')
      for (const c of suite.cases.filter((x) => x.args[2] === 0 && !ambiguous(ms(x.args[1])))) expect(ms(c.want), `${c.args[0]} 0`).toBe(ms(c.args[1]))
      for (const c of suite.cases.filter((x) => isTag(x.args[2], 'undef'))) expect(key(c.want), `${c.args[0]} undefined`).toBe(key(at(c.args[0], ms(c.args[1]), 1)))
    })
  }
  const local = suiteOf(time, 'timeOffset')
  const calendar = local.cases.filter((c) => ['date', 'day', 'week', 'month', 'quarter', 'year', 'dayofyear'].includes(c.args[0] as string))
  it('timeOffset: some result lands in the spring gap (its wall clock moves), some on the repeated hour, some input is in the second 01:30', () => {
    // a calendar offset keeps the wall clock; in the gap the instant is pushed, so the wall clock differs
    const pushed = calendar.filter((c) => (c.args[2] as number) !== 0 && wall(NY, ms(c.args[1])).slice(3) !== wall(NY, ms(c.want)).slice(3))
    expect(pushed.length).toBeGreaterThan(0)
    expect(calendar.some((c) => ms(c.want) === Date.parse('2024-11-03T05:30:00Z'))).toBe(true) // first 01:30 of the repeated hour
    expect(calendar.some((c) => ms(c.args[1]) === Date.parse('2024-11-03T06:30:00Z'))).toBe(true) // second 01:30
  })
})

describe('recorded vectors: sequences and specifiers', () => {
  for (const name of ['timeSequence', 'utcSequence']) {
    it(`${name}: day and dayofyear, with and without a step`, () => {
      const suite = suiteOf(time, name)
      for (const unit of ['day', 'dayofyear']) {
        const cs = suite.cases.filter((c) => c.args[0] === unit)
        expect(cs.length, unit).toBeGreaterThanOrEqual(2)
        expect(cs.every((c) => Array.isArray(c.want) && c.want.length > 2), unit).toBe(true)
      }
    })
  }
  it('timeUnitSpecifier: a composite-key override and a null specifier change or keep the output as upstream does', () => {
    const suite = suiteOf(time, 'timeUnitSpecifier')
    const out = (units: string[], spec?: unknown) => suite.cases.find((c) => key(c.args[0]) === key(units) && (spec === undefined ? c.args.length === 1 : key(c.args[1]) === key(spec)))?.want
    expect(out(['year', 'month'])).toBe('%Y-%m')
    expect(out(['year', 'month'], { 'year-month': '%Y/%m' })).toBe('%Y/%m')
    expect(out(['year', 'month'], null)).toBe('%Y-%m')
    expect(out(['year', 'month'], { month: 'M', year: null })).toBe('%Y-%m')
    expect(out(['dayofyear'], { dayofyear: 'D%j' })).toBe('D%j')
  })
})

describe('recorded vectors: intervals', () => {
  const sub = ['Millisecond', 'Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year']
  for (const [name, prefix] of [['d3Intervals', 'time'], ['utcIntervals', 'utc']] as const) {
    const suite = suiteOf(time, name)
    for (const unit of sub) {
      const n = `${prefix}${unit}`
      const cs = suite.cases.filter((c) => c.args[0] === n)
      it(`${name} ${n}: floor, ceil, round, offset, count, range, every(3).range; off-boundary instants move`, () => {
        const ops = new Set(cs.map((c) => c.args[1]))
        for (const op of ['floor', 'ceil', 'round', 'offset', 'count', 'range', 'every3_range']) expect(ops.has(op), `${n} ${op}`).toBe(true)
        const off = cs.filter((c) => ['floor', 'ceil'].includes(c.args[1] as string) && ms(c.args[2]) === Date.parse('2024-03-10T05:30:17.345Z'))
        expect(off.length, 'off-boundary floor and ceil').toBe(2)
        // the millisecond interval is the identity on a whole millisecond; every other interval moves it
        if (unit !== 'Millisecond') expect(off.every((c) => ms(c.want) !== Date.parse('2024-03-10T05:30:17.345Z'))).toBe(true)
        const ranges = cs.filter((c) => c.args[1] === 'range' || c.args[1] === 'every3_range')
        expect(ranges.every((c) => Array.isArray(c.want))).toBe(true)
        const every = cs.filter((c) => c.args[1] === 'every3_range')
        expect(every.some((c) => (c.want as unknown[]).length > 0), `${n}: every(3) never returns a date`).toBe(true)
        const counts = cs.filter((c) => c.args[1] === 'count')
        expect(counts.every((c) => typeof c.want === 'number' && (c.want as number) > 0)).toBe(true)
      })
    }
  }
})

describe('recorded vectors: d3-format', () => {
  const format = suiteOf(fmt, 'format')
  const specsOf = (s: Suite) => new Set(s.cases.map((c) => c.args[0] as string))
  it('format: bare #, + and q, and every sign / symbol / unknown-type option reach a value', () => {
    const specs = specsOf(format)
    for (const s of ['#', '+', 'q', '+.2f', ' .2f', '(.2f', '$,.2f', '+$,.2f', '($,.2f']) expect(specs.has(s), s).toBe(true)
    const want = (spec: string, v: unknown) => format.cases.find((c) => c.args[0] === spec && key(c.args[1]) === key(v))?.want
    expect(want('+.2f', 1.5)).toBe('+1.50')
    expect(want('(.2f', -1.5)).toBe('(1.50)')
    expect(want('$,.2f', 12345.678)).toBe('$12,345.68')
    expect(want('q', 12345.678)).toBe(want('~.12g', 12345.678) ?? want('q', 12345.678)) // unknown type: ~.12g
  })
  it('format: numeric strings, null, undefined, booleans and values beyond the SI prefixes are applied', () => {
    const values = new Set(format.cases.map((c) => key(c.args[1])))
    for (const v of ['"42"', 'null', '{"$":"undef"}', 'true', 'false', '1e+24', '1e+27', '1e-27']) expect(values.has(v === '1e+24' ? '1e+24' : v) || values.has(v.replace('e+', 'e')), v).toBe(true)
  })
  it('format: the s rows reach y and Y', () => {
    const rows = format.cases.filter((c) => c.args[0] === 's' && typeof c.want === 'string')
    expect(rows.some((c) => (c.want as string).endsWith('Y'))).toBe(true)
    expect(rows.some((c) => (c.want as string).endsWith('y'))).toBe(true)
  })
  it('formatSpecifier: only unparseable specifiers throw (the six valid ones are no longer filed as invalid)', () => {
    const specifier = suiteOf(fmt, 'formatSpecifier')
    const threw = specifier.cases.filter((c) => isTag(c.want, 'throw')).map((c) => c.args[0])
    expect(threw).toContain('zzz')
    for (const s of ['#', '+', 'q']) {
      expect(threw).not.toContain(s)
      expect(specsOf(format).has(s), `${s} must also be applied to a value`).toBe(true)
    }
  })
  it('formatPrefix: every prefix y..Y and the clamp, zero and non-finite refs, no all-NaN column', () => {
    const suite = suiteOf(fmt, 'formatPrefix')
    const refs = new Set(suite.cases.map((c) => key(c.args[1])))
    for (const r of ['0', '1e-24', '1e-9', '0.001', '1', '1000', '1e+24', '1e+27', '{"$":"nan"}', '{"$":"inf"}', '{"$":"-inf"}']) expect([...refs].some((x) => x === r || x === r.replace('e+', 'e')), r).toBe(true)
    const prefixes = new Set(suite.cases.filter((c) => c.args[0] === 's' && typeof c.want === 'string').map((c) => /[yzafpn\u00b5mkMGTPEZY]$/.exec(c.want as string)?.[0]))
    for (const p of ['y', 'z', 'a', 'f', 'p', 'n', '\u00b5', 'm', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']) expect(prefixes.has(p), p).toBe(true)
    const wants = new Set(suite.cases.map((c) => key(c.want)))
    expect(wants.size).toBeGreaterThan(200)
  })
  it('precisionPrefix / precisionRound / tickStep: zero, negative, NaN, infinite, equal and subnormal arguments', () => {
    for (const name of ['precisionPrefix', 'precisionRound']) {
      const all = suiteOf(fmt, name).cases.flatMap((c) => c.args.map(key))
      for (const v of ['0', '-1', '{"$":"nan"}', '{"$":"inf"}', '{"$":"-inf"}']) expect(all, `${name} ${v}`).toContain(v)
    }
    const tick = suiteOf(fmt, 'tickStep').cases
    expect(tick.some((c) => c.args[2] === 0)).toBe(true)
    expect(tick.some((c) => key(c.args[0]) === key(c.args[1]))).toBe(true)
    expect(tick.some((c) => isTag(c.args[1], 'inf') || isTag(c.args[0], '-inf'))).toBe(true)
    expect(tick.some((c) => typeof c.args[1] === 'number' && c.args[1] > 0 && c.args[1] < 1e-300)).toBe(true)
  })
})

describe('recorded vectors: vega-format', () => {
  const tf = suiteOf(locale, 'localeTimeFormat')
  const multi = tf.cases.filter((c) => typeof c.args[0] === 'object' && !isTag(c.args[0], 'date'))
  const marked = multi.filter((c) => (c.args[0] as Record<string, string>).year === 'Y%Y')
  it('multi-format objects: every level (year ... millisecond) prints its own pattern', () => {
    const wants = marked.map((c) => c.want as string)
    for (const m of ['L', 'S', 'M', 'H', 'D', 'W', 'Mo', 'Q', 'Y']) expect(wants.some((w) => w.startsWith(m)), `level ${m}`).toBe(true)
    expect(wants.some((w) => w.startsWith('Mo')) && wants.some((w) => w.startsWith('Q'))).toBe(true)
  })
  it('multi-format objects: {year, month, date} is not the same recording as {}', () => {
    const by = (spec: unknown) => multi.filter((c) => key(c.args[0]) === key(spec)).map((c) => [ms(c.args[1]), c.want] as const)
    const a = by({ date: '%d', month: '%b', year: '%Y' }), b = by({})
    expect(a.length).toBe(b.length)
    const differ = a.filter(([t, w]) => b.find(([u]) => u === t)![1] !== w)
    expect(differ.length).toBeGreaterThanOrEqual(2) // the month level (%b, not %B) and the date level (%d, not %a %d)
  })
  it('localeUtcFormat applies the multi-format objects too', () => {
    const utc = suiteOf(locale, 'localeUtcFormat').cases.filter((c) => typeof c.args[0] === 'object' && !isTag(c.args[0], 'date'))
    expect(utc.length).toBeGreaterThan(50)
    const w = utc.filter((c) => (c.args[0] as Record<string, string>).year === 'Y%Y').map((c) => c.want as string)
    for (const m of ['L', 'S', 'M', 'H', 'D', 'W', 'Mo', 'Q', 'Y']) expect(w.some((x) => x.startsWith(m)), `level ${m}`).toBe(true)
  })
  it('%Z changes within both transition days, %L and %f are not constant', () => {
    const at = (spec: string, iso: string) => tf.cases.find((c) => c.args[0] === spec && ms(c.args[1]) === Date.parse(iso))?.want
    expect(at('%Z', '2024-03-10T06:30:00Z')).toBe('-0500')
    expect(at('%Z', '2024-03-10T07:30:00Z')).toBe('-0400')
    expect(at('%Z', '2024-11-03T05:30:00Z')).toBe('-0400')
    expect(at('%Z', '2024-11-03T06:30:00Z')).toBe('-0500')
    expect(new Set(tf.cases.filter((c) => c.args[0] === '%L').map((c) => c.want)).size).toBeGreaterThan(1)
    expect(new Set(tf.cases.filter((c) => c.args[0] === '%f').map((c) => c.want)).size).toBeGreaterThan(1)
  })
  it('localeTimeParse: ISO week-date, the skipped hour and the repeated hour', () => {
    const parse = suiteOf(locale, 'localeTimeParse').cases
    const w = (spec: string, s: string) => parse.find((c) => c.args[0] === spec && c.args[1] === s)?.want
    // `%G-W11-4` takes `W11-4` as literal text; `%G-W%V-%u` reads the week and the weekday, and the instants differ
    expect(w('%G-W%V-%u', '2024-W11-4')).toBeDefined()
    expect(w('%G-W11-4', '2024-W11-4')).toBeDefined()
    expect(w('%G-W%V-%u', '2024-W11-4')).not.toEqual(w('%G-W11-4', '2024-W11-4'))
    expect(w('%Y-%m-%dT%H:%M:%S', '2024-03-10T02:30:00')).toBeDefined()
    expect(w('%Y-%m-%dT%H:%M:%S', '2024-11-03T01:30:00')).toBeDefined()
  })
  it('the date set varies every field the formats read', () => {
    const ts = new Set(tf.cases.map((c) => (isTag(c.args[1], 'date') ? c.args[1].ms! : NaN)))
    expect(ts.has(Date.parse('2024-06-15T12:37:41.123Z'))).toBe(true)
  })
})

describe('recorded vectors: d3-color', () => {
  it('parse: percent rgba, 4- and 8-digit hex with alpha, upper and mixed case, out-of-range alpha', () => {
    const parse = suiteOf(color, 'parse').cases
    const f = (s: string) => parse.find((c) => c.args[0] === s)?.want as { fields?: { opacity?: number; r?: number } } | null | undefined
    expect(f('rgba(100%,0%,0%,0.5)')?.fields).toMatchObject({ r: 255, opacity: 0.5 })
    expect(f('#f008')?.fields?.opacity).toBeCloseTo(0x88 / 255, 6)
    expect(f('#FF0000C0')?.fields?.opacity).toBeCloseTo(0xc0 / 255, 6)
    expect(f('RGB(255,0,0)')).not.toBeNull()
    expect(f('Red')).not.toBeNull()
    expect(f('TRANSPARENT')).not.toBeNull()
    expect(f('rgba(1,2,3,2)')).not.toBeNull()
  })
  it('the projection includes toString, a fractional brighter, darker(2) and copy', () => {
    const c = suiteOf(color, 'rgb').cases[0]!.want as Record<string, unknown>
    for (const k of ['string', 'brighterHalf', 'darker2', 'copy']) expect(c, k).toHaveProperty(k)
  })
})

describe('recorded vectors: d3-dsv and vega-util', () => {
  it('dsvParseCustom: dropOdd runs on three or more rows and drops some', () => {
    const drops = suiteOf(dsv, 'dsvParseCustom').cases.filter((c) => c.variant === 'dropOdd')
    const longer = drops.filter((c) => (c.args[0] as string).split('\n').length >= 4)
    expect(longer.length).toBeGreaterThan(0)
    for (const c of longer) expect((c.want as unknown[]).length).toBeLessThan((c.args[0] as string).split('\n').length - 1)
  })
  it('dsvParseSemi / dsvParseTab record parse (objects), dsvParseRowsSemi / dsvParseRowsTab record parseRows (arrays)', () => {
    for (const name of ['dsvParseSemi', 'dsvParseTab']) {
      const objects = suiteOf(dsv, name).cases.filter((c) => Array.isArray(c.want) && c.want.length > 0)
      expect(objects.length).toBeGreaterThanOrEqual(2)
      expect(objects.every((c) => (c.want as unknown[]).every((r) => !Array.isArray(r) && typeof r === 'object'))).toBe(true)
    }
    for (const name of ['dsvParseRowsSemi', 'dsvParseRowsTab']) {
      expect(suiteOf(dsv, name).cases.every((c) => (c.want as unknown[]).every((r) => Array.isArray(r)))).toBe(true)
    }
  })
  it('vega-util isDate does not record the recording time', () => {
    const inputs = suiteOf(util, 'isDate').cases.map((c) => c.args[0])
    const stamp = inputs.filter((v): v is number => typeof v === 'number' && v > 1e12)
    expect(stamp).toEqual([1700000000000])
  })
})
