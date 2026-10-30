/**
 * GENERATED live differential of date formatting and parsing: Aster's `time-format.ts` and the time half of
 * `locale.ts` against the pinned d3-time-format and vega-format in one process, local and UTC, in zones with and
 * without daylight saving (America/New_York, Australia/Lord_Howe, Pacific/Apia, Asia/Kolkata, UTC).
 *
 * Specifiers are composed from every directive (and several that do not exist), the three padding modifiers and
 * literal text; instants cluster around offset changes and the ends of the Date range; parsed strings are the output
 * of the oracle's own formatter, then damaged (a character removed, swapped, repeated, case-changed, junk appended),
 * plus free-form garbage. Locales are generated too: names with regex metacharacters, empty names, duplicates.
 */
import * as d3 from 'd3-time-format'
import * as vf from 'vega-format'
import { describe, expect, it, vi } from 'vitest'
import * as aster from '../../core/src/time-format.ts'
import { locale as asterLocale, timeFormatLocale as asterTimeLocale } from '../../core/src/locale.ts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'
import { withTz } from './differential-util.mts'
import { ZONES, genInstant, offsetChanges } from './differential-zones.mts'

vi.setConfig({ testTimeout: 120_000 })

const DIRECTIVES = 'aAbBcdeFfgGHIjLmMpqQsSuUVwWxXyYZ%EOKklPrRTDhntCNiJvo'.split('')
const PADS = ['-', '_', '0']
const LITERALS = ['', ' ', '-', ':', '/', 'T', '.', ',', '(', 'é', '\\', '*', '[', '$', 'Z', 'at ', '\n', '%%', '😀']

function genFormatSpec(r: Rng): string {
  const parts: string[] = []
  const n = r.between(1, 6)
  for (let i = 0; i < n; i++) {
    if (r.chance(0.28)) parts.push(r.pick(LITERALS))
    else parts.push('%' + (r.chance(0.3) ? r.pick(PADS) : '') + r.pick(DIRECTIVES))
  }
  if (r.chance(0.04)) parts.push(r.pick(['%', '%-', '%_', '%0']))
  return parts.join('')
}

/** Specifiers that mean something when parsing: whole dates, times, ISO weeks, timestamps, zones. */
const PARSE_SPECS = [
  '%Y-%m-%d', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S.%LZ', '%Y-%m-%d %H:%M:%S %Z', '%b %d, %Y', '%A, %B %e, %Y', '%a %b %e %H:%M:%S %Y',
  '%I:%M %p', '%I:%M:%S.%L %p', '%j %Y', '%U %w %Y', '%W %u %Y', '%V %G', '%g-%V-%u', '%Q', '%s', '%s.%L', '%Z', '%f', '%L', '%q %Y',
  '%y', '%y%m%d', '%m/%d/%y', '%x', '%X', '%c', '%x %X', '%e %b %Y', '%H%M%S', '%H:%M', '%-m/%-d/%Y', '%_d.%_m.%Y', '%0e', '%Y%j', '%G-W%V-%u', '%%%Y%%',
]

const NAME_ALPHABET = ['a', 'b', 'é', 'I', 'i', 'İ', '.', '(', ')', '[', '|', '*', '+', '?', '^', '$', '\\', ' ', 'ß', 'Σ', 'ς', 'A', '1']

function genNames(r: Rng, n: number, short: boolean): string[] {
  const names = Array.from({ length: n }, (_, i) => r.text(NAME_ALPHABET, short ? 1 : 0, short ? 3 : 7) + (r.chance(0.5) ? String(i) : ''))
  if (r.chance(0.12)) names[r.int(n)] = names[r.int(n)]!
  if (r.chance(0.08)) names[r.int(n)] = ''
  return names
}

function genTimeLocale(r: Rng): Record<string, unknown> {
  const simple = () => r.pick(['%Y-%m-%d', '%d.%m.%Y', '%-m/%-d/%y', '%e %b %Y', '%A %d', '%H:%M', '%-I:%M %p', '%H.%M.%S', '%j', '%a, %d %B'])
  const def: Record<string, unknown> = {
    dateTime: r.pick(['%x %X', '%A %x', '%X, %x', '%a %b %e %X %Y', '%x', '%B %X']),
    date: simple(),
    time: r.pick(['%H:%M:%S', '%-I:%M:%S %p', '%H.%M', '%I %p', simple()]),
    periods: genNames(r, 2, true),
    days: genNames(r, 7, false),
    shortDays: genNames(r, 7, true),
    months: genNames(r, 12, false),
    shortMonths: genNames(r, 12, true),
  }
  if (r.chance(0.05)) {
    const key = r.pick(['periods', 'days', 'shortDays', 'months', 'shortMonths'])
    const broken = r.pick<unknown>([undefined, [], ['x'], 'abc', 5, null])
    if (broken === undefined) delete def[key]
    else def[key] = broken
  }
  return def
}

const showInstant = (t: number): string => (Number.isNaN(new Date(t).getTime()) ? String(t) : `${t} (${new Date(t).toISOString()})`)

/** The values a formatter is called with: Dates (valid and not) and things `+value` can read. */
function formatInputs(r: Rng, changes: readonly number[]): { label: string; value: unknown }[] {
  const out: { label: string; value: unknown }[] = []
  for (let i = 0; i < 3; i++) {
    const t = genInstant(r, changes)
    out.push({ label: showInstant(t), value: r.chance(0.8) ? new Date(t) : t })
  }
  if (r.chance(0.08)) {
    const odd = r.pick<[string, unknown]>([['null', null], ['undefined', undefined], ['"2020"', '2020'], ['"x"', 'x'], ['true', true], ['[5]', [5]], ['{}', {}]])
    out.push({ label: odd[0], value: odd[1] })
  }
  return out
}

function damage(r: Rng, text: string): string {
  let s = text
  const n = r.pick([0, 0, 1, 1, 2, 3])
  for (let i = 0; i < n; i++) {
    const at = r.int(s.length + 1)
    switch (r.int(9)) {
      case 0: s = s.slice(0, at) + s.slice(at + 1); break
      case 1: s = s.slice(0, at) + r.pick(['0', '9', ' ', 'x', '-', '+', ':', '.', '/', 'Z']) + s.slice(at + 1); break
      case 2: s = s.slice(0, at) + s.charAt(at) + s.slice(at); break
      case 3: s = s.toUpperCase(); break
      case 4: s = s.toLowerCase(); break
      case 5: s += r.pick([' ', 'x', '0', ' PM', 'Z', '+0100', '-05:30', '\n']); break
      case 6: s = r.pick([' ', '0', 'x']) + s; break
      case 7: s = s.slice(0, at); break
      default: s = s.slice(at); break
    }
  }
  return s
}

const GARBAGE = [
  '', ' ', 'x', '0', '12', '1710054000', '1710054000123', '-5', '2024', '24', '23:59:60', '2024-03-10 02:30:00', '12/31/99', 'Mon Mar 10 2024',
  'Sunday 5', 'AM 12', '2024 W10 3', '100 2024', '  7', '+0100', 'Z', '2024-02-30', '2024-13-01', '00', '99', '366 2024', '53 2020', '0 1', '7 0',
  '2024-W10-3', '2024-12-31T10:00:00Z', 'JAN', 'january 5, 2024', '1e3', '0x10', '٣', '1.5',
]

describe('time format and parse vs d3-time-format (generated, live)', () => {
  for (const tz of ZONES) {
    describe(tz, () => {
      it('timeFormat and utcFormat over generated specifiers and instants', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x7f01)
          const stats = compareCases(`format ${tz}`, scaled(7000), () => {
            const spec = genFormatSpec(r)
            const inputs = formatInputs(r, changes)
            return {
              label: `${JSON.stringify(spec)} ${inputs.map((i) => i.label).join(' | ')}`,
              oracle: () => [d3.timeFormat(spec)(inputs[0]!.value as Date), ...inputs.map((i) => [d3.timeFormat(spec)(i.value as Date), d3.utcFormat(spec)(i.value as Date)]), String(d3.timeFormat(spec))],
              aster: () => [aster.timeFormat(spec)(inputs[0]!.value), ...inputs.map((i) => [aster.timeFormat(spec)(i.value), aster.utcFormat(spec)(i.value)]), String(aster.timeFormat(spec))],
            }
          })
          expect(stats.refused).toBeLessThan(stats.cases * 0.05)
        })
      })

      it('every directive on its own, with and without each padding modifier', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x7f02)
          const specs = DIRECTIVES.flatMap((c) => ['%' + c, ...PADS.map((p) => '%' + p + c)])
          const instants = Array.from({ length: scaled(120) }, () => genInstant(r, changes))
          compareCases(`directives ${tz}`, specs.length * instants.length, (i) => {
            const spec = specs[i % specs.length]!
            const t = instants[Math.floor(i / specs.length)]!
            return {
              label: `${spec} ${showInstant(t)}`,
              oracle: () => [d3.timeFormat(spec)(new Date(t)), d3.utcFormat(spec)(new Date(t))],
              aster: () => [aster.timeFormat(spec)(new Date(t)), aster.utcFormat(spec)(new Date(t))],
            }
          })
        })
      })

      it('timeParse and utcParse of damaged round-trips and garbage', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x7f03)
          const stats = compareCases(`parse ${tz}`, scaled(9000), () => {
            const spec = r.chance(0.6) ? r.pick(PARSE_SPECS) : genFormatSpec(r)
            const utc = r.chance(0.4)
            let text: string
            if (r.chance(0.2)) text = r.pick(GARBAGE)
            else {
              const t = genInstant(r, changes)
              let made = ''
              try { made = (utc ? d3.utcFormat(spec) : d3.timeFormat(spec))(new Date(Number.isNaN(t) ? 0 : t)) } catch { /* unreachable */ }
              text = damage(r, made)
            }
            const input: unknown = r.chance(0.04) ? r.pick<unknown>([12, null, undefined, ['2024'], { toString: () => '2024' }]) : text
            return {
              label: `${utc ? 'utc' : 'local'} ${JSON.stringify(spec)} on ${JSON.stringify(input)}`,
              oracle: () => (utc ? d3.utcParse(spec) : d3.timeParse(spec))(input as string),
              aster: () => (utc ? aster.utcParse(spec) : aster.timeParse(spec))(input as string),
            }
          })
          expect(stats.informative, 'parses that produce a date').toBeGreaterThan(stats.cases * 0.2)
        })
      })

      it('every parse directive against strings made by the oracle formatter', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x7f04)
          const specs = DIRECTIVES.flatMap((c) => ['%' + c, ...PADS.map((p) => '%' + p + c)])
          const instants = Array.from({ length: scaled(60) }, () => genInstant(r, changes)).filter((t) => !Number.isNaN(t))
          compareCases(`parse directives ${tz}`, specs.length * instants.length, (i) => {
            const spec = specs[i % specs.length]!
            const t = instants[Math.floor(i / specs.length)]!
            const utc = i % 2 === 0
            const text = (utc ? d3.utcFormat(spec) : d3.timeFormat(spec))(new Date(t))
            return {
              label: `${utc ? 'utc' : 'local'} ${spec} ${JSON.stringify(text)}`,
              oracle: () => (utc ? d3.utcParse(spec) : d3.timeParse(spec))(text),
              aster: () => (utc ? aster.utcParse(spec) : aster.timeParse(spec))(text),
            }
          })
        })
      })

      it('format then parse with a composite specifier agrees on the instant and on the failures', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x7f05)
          compareCases(`roundtrip ${tz}`, scaled(3000), () => {
            const spec = r.pick(['%Y-%m-%dT%H:%M:%S.%L%Z', '%Y-%m-%d %H:%M:%S', '%Y-%j %H', '%G-W%V-%u %H:%M', '%Y %U %w', '%Y %W %u', '%s', '%Q', '%a %b %e %Y %I:%M:%S.%L %p'])
            const t = genInstant(r, changes)
            return {
              label: `${spec} ${showInstant(t)}`,
              oracle: () => { const s = d3.timeFormat(spec)(new Date(t)); return [s, d3.timeParse(spec)(s), d3.utcParse(spec)(s)] },
              aster: () => { const s = aster.timeFormat(spec)(new Date(t)); return [s, aster.timeParse(spec)(s), aster.utcParse(spec)(s)] },
            }
          })
        })
      })
    })
  }

  it('the functions carry their specifier: toString, and a formatter reused across inputs', () => {
    for (const spec of ['%Y', '%-d/%m', 'text %%', '']) {
      expect(String(aster.timeFormat(spec))).toBe(String(d3.timeFormat(spec)))
      expect(String(aster.utcParse(spec))).toBe(String(d3.utcParse(spec)))
    }
    const odd: unknown[] = [undefined, null, 5, { toString: () => '%Y' }, ['%Y']]
    for (const spec of odd) {
      expect(String(aster.timeFormat(spec as string))).toBe(String(d3.timeFormat(spec as string)))
      expect(aster.utcFormat(spec as string)(new Date(0))).toBe(d3.utcFormat(spec as string)(new Date(0)))
    }
  })

  it('isoFormat, isoParse and isoSpecifier', () => {
    const r = makeRng(0x7f06)
    expect(aster.isoSpecifier).toBe('%Y-%m-%dT%H:%M:%S.%LZ')
    compareCases('iso', scaled(2500), () => {
      const t = genInstant(r, [])
      const text = r.pick([new Date(t).toString(), 'x', '', '2024-03-10', '2024-03-10T01:02:03Z', '2024-03-10T01:02:03.123+05:30', '2024', '12/31/1999', String(t), '+275760-09-13T00:00:00.000Z', '-000001-01-01T00:00:00Z'])
      return {
        label: `${t} ${JSON.stringify(text)}`,
        oracle: () => [d3.isoFormat(new Date(t)), d3.isoParse(text)],
        aster: () => [aster.isoFormat(new Date(t)), aster.isoParse(text)],
      }
    })
  })
})

describe('time locales vs d3-time-format and vega-format (generated, live)', () => {
  it('timeFormatLocale(definition): names, periods and composite patterns', async () => {
    await withTz('America/New_York', () => {
      const changes = offsetChanges('America/New_York')
      const r = makeRng(0x7f11)
      const stats = compareCases('timeFormatLocale', scaled(3500), () => {
        const def = genTimeLocale(r)
        const spec = r.chance(0.5)
          ? r.pick(['%a %A %b %B %p %c %x %X', '%x', '%X', '%c', '%b %d %Y', '%A, %B %e', '%I %p'])
          : genFormatSpec(r)
        const parseSpec = r.pick(['%a %b %d', '%A %B', '%x', '%X', '%c', '%p %I', '%b', '%B %Y', '%a', '%A', spec])
        const t = genInstant(r, changes)
        let base = ''
        try { base = d3.timeFormatLocale(def as never).format(spec)(new Date(t)) } catch { /* a malformed locale: both sides refuse */ }
        const damaged = damage(r, base)
        return {
          label: `${JSON.stringify(def)} ${JSON.stringify(spec)} / parse ${JSON.stringify(parseSpec)} ${showInstant(t)}`,
          oracle: () => {
            const l = d3.timeFormatLocale(def as never)
            const text = l.format(spec)(new Date(t))
            return [text, l.utcFormat(spec)(new Date(t)), l.parse(parseSpec)(text), l.utcParse(parseSpec)(damaged), damaged]
          },
          aster: () => {
            const l = aster.timeFormatLocale(def as never)
            const text = l.format(spec)(new Date(t))
            return [text, l.utcFormat(spec)(new Date(t)), l.parse(parseSpec)(text), l.utcParse(parseSpec)(damaged), damaged]
          },
        }
      })
      expect(stats.cases).toBeGreaterThan(0)
    })
  })

  it('timeFormatDefaultLocale swaps the module-level formatters', () => {
    const def = { dateTime: '%A %x', date: '%d/%m/%Y', time: '%H:%M', periods: ['fm', 'em'], days: ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'], shortDays: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], months: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12'], shortMonths: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'] }
    const en = { dateTime: '%x, %X', date: '%-m/%-d/%Y', time: '%-I:%M:%S %p', periods: ['AM', 'PM'], days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], shortDays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] }
    try {
      d3.timeFormatDefaultLocale(def)
      aster.timeFormatDefaultLocale(def)
      for (const spec of ['%c', '%a %b %d', '%x %X %p']) {
        expect(aster.utcFormat(spec)(new Date(0))).toBe(d3.utcFormat(spec)(new Date(0)))
        expect(aster.utcParse(spec)('x')).toEqual(d3.utcParse(spec)('x'))
      }
      expect(aster.utcParse('%A %d/%m/%Y')('d2 05/03/2024')).toEqual(d3.utcParse('%A %d/%m/%Y')('d2 05/03/2024'))
    } finally {
      d3.timeFormatDefaultLocale(en)
      aster.timeFormatDefaultLocale(en)
    }
    expect(aster.utcFormat('%A %B')(new Date(0))).toBe(d3.utcFormat('%A %B')(new Date(0)))
  })
})

describe('vega-format time functions vs the pinned vega-format (generated, live)', () => {
  const MULTI_KEYS = ['milliseconds', 'seconds', 'minutes', 'hours', 'date', 'day', 'week', 'month', 'quarter', 'year']
  const MULTI_FORMATS = ['%L ms', '%S s', '%H:%M', '%Hh', '%a %d', '%d', '%b %d', '%B', '%Y', 'Q%q', '', '%x', '%I:%M %p']

  function genMultiSpec(r: Rng): unknown {
    if (r.chance(0.12)) return r.pick<unknown>([{}, null, undefined, 0, '', false, 5, true, [], ['%Y'], () => 1])
    const spec: Record<string, unknown> = {}
    for (const key of MULTI_KEYS) if (r.chance(0.35)) spec[key] = r.pick<unknown>(MULTI_FORMATS)
    return spec
  }

  for (const tz of ZONES) {
    it(`timeFormat / utcFormat with a multi-format object (${tz})`, async () => {
      await withTz(tz, () => {
        const changes = offsetChanges(tz)
        const r = makeRng(0x7f21)
        // instants at the unit boundaries the multi-format dispatches on
        const boundary = (t: number): number => {
          const d = new Date(t)
          if (Number.isNaN(+d)) return t
          const level = r.int(9)
          const y = d.getFullYear(), mo = d.getMonth()
          return [new Date(y, 0, 1), new Date(y, mo, 1), new Date(y, mo, d.getDate() - d.getDay()), new Date(y, mo, d.getDate()), new Date(y, mo, d.getDate(), d.getHours()),
            new Date(y, mo, d.getDate(), d.getHours(), d.getMinutes()), new Date(y, mo, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()), d, new Date(y, (mo - (mo % 3)), 1)][level]!.getTime()
        }
        compareCases(`multi-format ${tz}`, scaled(3000), () => {
          const spec = genMultiSpec(r)
          const utc = r.chance(0.5)
          const t = r.chance(0.6) ? boundary(genInstant(r, changes)) : genInstant(r, changes)
          const value: unknown = r.chance(0.85) ? new Date(t) : t
          return {
            label: `${utc ? 'utc' : 'local'} ${String(JSON.stringify(spec))} ${showInstant(t)}`,
            oracle: () => (utc ? vf.locale().utcFormat(spec as never) : vf.locale().timeFormat(spec as never))(value as Date),
            aster: () => (utc ? asterLocale().utcFormat(spec) : asterLocale().timeFormat(spec))(value),
          }
        })
      })
    })
  }

  it('locale(numberSpec, timeSpec) with generated time locales: format, parse, multi-format', async () => {
    await withTz('America/New_York', () => {
      const r = makeRng(0x7f22)
      compareCases('vega-format time locale', scaled(2500), () => {
        const def = r.chance(0.15) ? undefined : genTimeLocale(r)
        const spec = r.chance(0.5) ? r.pick(['%a %b %d', '%x', '%c', '%X', '%A', '%B %Y', '%p']) : genFormatSpec(r)
        const t = genInstant(r, [])
        const multi = genMultiSpec(r)
        const run = (loc: typeof vf.locale) => {
          const l = loc(undefined as never, def as never)
          const text = l.timeFormat(spec as never)(new Date(t))
          return [text, l.utcFormat(spec as never)(new Date(t)), l.timeParse(spec)(text), l.utcParse(spec)(text), l.timeFormat(multi as never)(new Date(t)), l.timeFormat(spec as never) === l.timeFormat(spec as never), l.utcParse(spec) === l.utcParse(spec)]
        }
        return {
          label: `${JSON.stringify(def)} ${JSON.stringify(spec)} ${showInstant(t)} ${JSON.stringify(multi)}`,
          oracle: () => run(vf.locale as never),
          aster: () => run(asterLocale as never),
        }
      })
    })
  })

  it('timeFormatLocale exposes the memoised formatters and parsers', () => {
    const def = { dateTime: '%x', date: '%Y', time: '%H', periods: ['a', 'b'], days: ['1', '2', '3', '4', '5', '6', '7'], shortDays: ['1', '2', '3', '4', '5', '6', '7'], months: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], shortMonths: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] }
    const a = asterTimeLocale(def)
    const o = vf.timeFormatLocale(def)
    expect(Object.keys(a).sort()).toEqual(Object.keys(o).sort())
    expect(a.timeFormat('%Y') === a.timeFormat('%Y')).toBe(o.timeFormat('%Y') === o.timeFormat('%Y'))
    expect(a.timeParse('%Y') === a.timeParse('%Y')).toBe(o.timeParse('%Y') === o.timeParse('%Y'))
    expect(() => a.timeFormat(5 as never)).toThrow('Invalid time multi-format specifier: 5')
    expect(() => o.timeFormat(5 as never)).toThrow('Invalid time multi-format specifier: 5')
  })
})
