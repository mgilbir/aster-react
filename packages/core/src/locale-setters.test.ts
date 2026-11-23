// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultLocale,
  locale,
  numberFormatDefaultLocale,
  renderSpec,
  resetDefaultLocale,
  timeFormatDefaultLocale,
  type FormatLocaleDefinition,
  type TimeLocaleDefinition,
} from './index.js'
import type { VgSpec } from './types.js'

const de: FormatLocaleDefinition = { decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'] }
const deTime: TimeLocaleDefinition = {
  dateTime: '%A, der %e. %B %Y, %X', date: '%d.%m.%Y', time: '%H:%M:%S', periods: ['AM', 'PM'],
  days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  shortDays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  shortMonths: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
}
const text: VgSpec = {
  width: 60, height: 20,
  marks: [{ type: 'text', encode: { enter: { text: { signal: "format(1234.5, ',.2f')" } } } }],
} as unknown as VgSpec
const rendered = (): string | undefined => renderSpec(text).match(/>([^<]*)<\/text>/)?.[1]
/** What formatting reads in the process now: the setters' result, the locale object, a rendered chart. */
const observed = (): string[] => [defaultLocale().format(',.2f')(1234.5), locale().timeFormat('%B')(new Date(Date.UTC(2024, 2, 5))), rendered() ?? '']

afterEach(() => resetDefaultLocale())

describe('the locale setters refuse what is not a definition, and change nothing when they refuse (C499)', () => {
  // (the declared types refuse an explicit `undefined`; a host that is not type checked, or a variable typed wider, reaches the call)
  const bad: Array<[string, unknown]> = [['undefined', undefined], ['null', null], ['a string', 'de'], ['a number', 3]]

  it.each(bad)('defaultLocale(definition, %s) throws an Error that names the call and leaves the number half alone', (_name, value) => {
    const before = observed()
    expect(before[0]).toBe('1,234.50')
    const set = defaultLocale as (...a: unknown[]) => unknown
    expect(() => set(de, value)).toThrow(/^defaultLocale expects a locale definition object/)
    expect(observed()).toEqual(before)
  })

  it.each(bad)('defaultLocale(%s, definition) throws an Error that names the call and leaves the time half alone', (_name, value) => {
    const before = observed()
    const set = defaultLocale as (...a: unknown[]) => unknown
    expect(() => set(value, deTime)).toThrow(/^defaultLocale expects a locale definition object/)
    expect(observed()).toEqual(before)
  })

  it.each(bad)('numberFormatDefaultLocale(%s) and timeFormatDefaultLocale(%s) throw an Error that names the call', (_name, value) => {
    const before = observed()
    expect(() => (numberFormatDefaultLocale as (...a: unknown[]) => unknown)(value)).toThrow(/^numberFormatDefaultLocale expects a locale definition object/)
    expect(() => (timeFormatDefaultLocale as (...a: unknown[]) => unknown)(value)).toThrow(/^timeFormatDefaultLocale expects a locale definition object/)
    expect(observed()).toEqual(before)
  })

  it('a definition that cannot be built (a time locale without months) replaces neither default', () => {
    const before = observed()
    const broken = { ...deTime, months: undefined } as unknown as TimeLocaleDefinition
    expect(() => defaultLocale(de, broken)).toThrow()
    expect(observed()).toEqual(before)
  })

  it('reading and setting still work: no arguments reads, a definition sets', () => {
    expect(numberFormatDefaultLocale().format(',.2f')(1234.5)).toBe('1,234.50')
    expect(timeFormatDefaultLocale().timeFormat('%B')(new Date(Date.UTC(2024, 2, 5)))).toBe('March')
    defaultLocale(de, deTime)
    expect(observed()).toEqual(['1.234,50', 'März', '1.234,50'])
    expect(locale(undefined, undefined).format(',.2f')(1234.5)).toBe('1.234,50') // a missing half of `locale()` is the default one
    expect(() => defaultLocale(de as never)).toThrow(/either zero or two arguments/)
  })
})
