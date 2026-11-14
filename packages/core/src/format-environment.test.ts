/**
 * What an evaluation keeps from the one before -- a scene a session hands back for an unchanged input, a kept mark, a kept scale --
 * was formatted under the default locale and in the time zone of then. Replacing the default locale or changing the time zone makes
 * the next evaluation format afresh: the scene equals a fresh evaluation's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import { defaultLocale, resetDefaultLocale } from './locale.js'
import type { VgSpec } from './types.js'

const DE_NUMBER = { decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'] }
const DE_TIME = {
  dateTime: '%A, der %e. %B %Y, %X', date: '%d.%m.%Y', time: '%H:%M:%S', periods: ['AM', 'PM'],
  days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'], shortDays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  shortMonths: ['Jan', 'Feb', 'Mrz', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
}

/** A text mark that formats a number and a local date, an axis over a local time scale, and a signal nothing reads. */
const SPEC: VgSpec = {
  width: 300, height: 100, padding: 5, autosize: 'none',
  signals: [{ name: 'other', value: 0 }],
  data: [{ name: 't', values: [{ v: 1234.5, d: 86400000 * 40.3 }, { v: 98765.25, d: 86400000 * 200.8 }] }],
  scales: [{ name: 'x', type: 'time', domain: { data: 't', field: 'd' }, range: 'width' }],
  axes: [{ scale: 'x', orient: 'bottom', tickCount: 4 }],
  marks: [
    { type: 'text', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'd' }, y: { value: 20 }, text: { signal: "format(datum.v, ',.2f') + ' ' + timeFormat(datum.d, '%b %d %H:%M')" } } } },
    { type: 'text', encode: { update: { x: { value: 0 }, y: { value: 90 }, text: { signal: "'' + other" } } } },
  ],
} as unknown as VgSpec

const fresh = (signals: Record<string, unknown>): string => renderSceneToSvg(evaluateChart(compileChart(SPEC), { signals }))

const zone = process.env.TZ
afterEach(() => {
  resetDefaultLocale()
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

describe('the default locale and the time zone are inputs of what an evaluation keeps', () => {
  it('a session hands back no scene made under another locale', () => {
    const session = createChartSession()
    const before = renderSceneToSvg(session.evaluate(SPEC, {}))
    defaultLocale(DE_NUMBER, DE_TIME)
    const after = renderSceneToSvg(session.evaluate(SPEC, {}))
    expect(after).toBe(fresh({}))
    expect(after).not.toBe(before)
  })

  it('a mark kept across a signal change is made again under another locale', () => {
    const session = createChartSession()
    session.evaluate(SPEC, { signals: { other: 1 } })
    defaultLocale(DE_NUMBER, DE_TIME)
    expect(renderSceneToSvg(session.evaluate(SPEC, { signals: { other: 2 } }))).toBe(fresh({ other: 2 }))
  })

  it('a session hands back no scene made in another time zone, nor keeps a mark', () => {
    process.env.TZ = 'UTC'
    const session = createChartSession()
    const before = renderSceneToSvg(session.evaluate(SPEC, {}))
    process.env.TZ = 'Asia/Kathmandu'
    const after = renderSceneToSvg(session.evaluate(SPEC, {}))
    expect(after).toBe(fresh({}))
    expect(after).not.toBe(before)
    process.env.TZ = 'America/St_Johns'
    expect(renderSceneToSvg(session.evaluate(SPEC, { signals: { other: 5 } }))).toBe(fresh({ other: 5 }))
  })
})
