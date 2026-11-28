// @vitest-environment node
/**
 * `config.locale`: a chart's own number and time locale (vega-view `locale(spec.locale.number, spec.locale.time)`), against vega.
 *
 * Every reader of the locale is drawn, each with a number half, a time half, both, and neither: axis and legend labels (linear, log,
 * time, utc, quantize, threshold, band with a format), their ARIA captions, expression `format` / `timeFormat` / `utcFormat` /
 * `timeParse` / `utcParse` / `monthFormat` / `dayFormat`, a text mark's `format`, and data parsed with a date pattern. The SVG is
 * compared canonically and strictly, and the datasets value for value.
 *
 * The locale is the chart's: two charts in different locales evaluated one after the other each keep their own, the process-wide
 * default is never touched, and a chart without one follows the default (also after `defaultLocale(...)` changes it).
 *
 * These run against the built packages (the `build` gate precedes `test`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vegaLite from 'vega-lite'
import { compile } from '@aster-charts/vl'
import { compileChart, datasetsOfScene, defaultLocale, evaluateChart, renderSpec, resetDefaultLocale } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Obj = Record<string, unknown>
/** vega's process-wide default locale (vega-format, re-exported by vega; its typings leave it out). */
const vegaLocale = vega as unknown as { defaultLocale(number: unknown, time: unknown): unknown; resetDefaultLocale(): unknown }

const DE_NUMBER = { decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'] }
const FR_TIME = {
  dateTime: '%A %e %B %Y à %X', date: '%d/%m/%Y', time: '%H:%M:%S', periods: ['AM', 'PM'],
  days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'], shortDays: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
  months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  shortMonths: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
}
const IN_NUMBER = { decimal: '.', thousands: ',', grouping: [3, 2], currency: ['₹', ''] }
const LOCALES: Record<string, Obj | undefined> = {
  'number': { number: DE_NUMBER },
  'time': { time: FR_TIME },
  'both': { number: IN_NUMBER, time: FR_TIME },
  'none (default)': undefined,
}

const T0 = Date.UTC(2020, 0, 1)
const DAY = 864e5
const rows = Array.from({ length: 6 }, (_, i) => ({ k: 'abcdef'[i], v: 1234.5 * (i + 1) * (i + 1), t: T0 + i * 47 * DAY }))
const scale = (name: string, type: string, field: string, range: unknown, extra: Obj = {}): Obj => ({ name, type, domain: { data: 'd', field }, range, ...extra })

/** One chart per reader of the locale. */
function charts(locale: Obj | undefined): Record<string, Obj> {
  const config = locale ? { config: { locale } } : {}
  const base = (extra: Obj): Obj => ({ width: 200, height: 120, padding: 5, data: [{ name: 'd', values: rows }], ...config, ...extra })
  return {
    'axis linear, a currency format': base({ scales: [scale('y', 'linear', 'v', 'height')], axes: [{ scale: 'y', orient: 'left', format: '$,.2f' }] }),
    'axis linear, the default format': base({ scales: [scale('y', 'linear', 'v', 'height')], axes: [{ scale: 'y', orient: 'left', tickCount: 4 }] }),
    'axis log': base({ scales: [scale('y', 'log', 'v', 'height')], axes: [{ scale: 'y', orient: 'left' }] }),
    'axis time': base({ scales: [scale('x', 'time', 't', 'width')], axes: [{ scale: 'x', orient: 'bottom' }] }),
    'axis utc, a format': base({ scales: [scale('x', 'utc', 't', 'width')], axes: [{ scale: 'x', orient: 'bottom', format: '%d %b %Y', tickCount: 3 }] }),
    'axis band with a number format': base({ scales: [scale('x', 'band', 'v', 'width')], axes: [{ scale: 'x', orient: 'bottom', format: ',.1f' }] }),
    'legend gradient': base({ scales: [scale('c', 'linear', 'v', { scheme: 'blues' })], legends: [{ fill: 'c', format: ',.1f' }] }),
    'legend quantize': base({ scales: [scale('c', 'quantize', 'v', { scheme: 'blues', count: 4 })], legends: [{ fill: 'c' }] }),
    'legend threshold': base({ scales: [{ name: 'c', type: 'threshold', domain: [1000, 10000.5], range: ['red', 'green', 'blue'] }], legends: [{ fill: 'c', format: '$,.1f' }] }),
    'legend time': base({ scales: [scale('c', 'time', 't', { scheme: 'blues' })], legends: [{ fill: 'c' }] }),
    'text: expression format functions': base({
      marks: [{
        type: 'text', from: { data: 'd' },
        encode: { update: { x: { value: 10 }, y: { signal: '10 + datum.v / 1000' }, text: { signal: "format(datum.v, '$,.2f') + ' ' + timeFormat(datum.t, '%A %d %B') + ' ' + utcFormat(datum.t, '%b') + ' ' + monthFormat(1) + ' ' + monthAbbrevFormat(2) + ' ' + dayFormat(1) + ' ' + dayAbbrevFormat(3)" } } },
      }],
    }),
    'title text from timeParse / utcParse': base({ title: { text: { signal: "'' + timeParse('3 mars 2021', '%d %B %Y') + ' / ' + utcParse('12 août 2020', '%d %B %Y')" } } }),
  }
}

/** Datasets that read the locale: data parsed with a date pattern (in the locale's month names), and formulas that format. */
function datasets(locale: Obj | undefined): Obj {
  return {
    ...(locale ? { config: { locale } } : {}),
    data: [
      { name: 'p', values: [{ d: '3 mars 2021' }, { d: '12 août 2020' }, { d: '1 May 2020' }], format: { parse: { d: 'date:"%d %B %Y"' } } },
      { name: 'u', values: [{ d: '3 mars 2021' }, { d: '12 août 2020' }], format: { parse: { d: 'utc:"%d %B %Y"' } } },
      { name: 'f', values: [{ v: 1234567.891, t: T0 }], transform: [{ type: 'formula', as: 's', expr: "format(datum.v, ',.2f') + '|' + timeFormat(datum.t, '%B %a') + '|' + timeParse('mars', '%B')" }] },
    ],
  }
}

async function oracle(spec: Obj): Promise<{ svg: string; data: Record<string, unknown> }> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    const data: Record<string, unknown> = {}
    for (const d of (spec.data as Obj[] | undefined) ?? []) data[d.name as string] = view.data(d.name as string)
    return { svg: await view.toSVG(), data }
  } finally {
    view.finalize()
  }
}
const diff = (theirs: string, ours: string): string[] => diffCanonical(canonicalizeSvg(theirs), canonicalizeSvg(ours))
const asJson = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x instanceof Date ? `Date(${x.getTime()})` : x))

afterEach(() => { resetDefaultLocale() })

describe('config.locale renders as vega renders it', () => {
  for (const [which, locale] of Object.entries(LOCALES)) {
    for (const [name, spec] of Object.entries(charts(locale))) {
      it(`${which}: ${name}`, async () => {
        expect(diff((await oracle(spec)).svg, renderSpec(spec as never))).toEqual([])
      })
    }
    it(`${which}: data parsed and formatted`, async () => {
      const spec = datasets(locale)
      const want = (await oracle(spec)).data
      const got = datasetsOfScene(evaluateChart(compileChart(structuredClone(spec) as never), {}))
      for (const name of Object.keys(want)) expect(asJson(got.get(name)), name).toBe(asJson(want[name]))
    })
  }
})

describe('the locale is the chart\'s', () => {
  it('charts in different locales evaluated in turn each keep their own, and the default is not touched', async () => {
    const de = charts({ number: DE_NUMBER })['axis linear, a currency format']!
    const inr = charts({ number: IN_NUMBER })['axis linear, a currency format']!
    const plain = charts(undefined)['axis linear, a currency format']!
    const [deWant, inrWant, plainWant] = [(await oracle(de)).svg, (await oracle(inr)).svg, (await oracle(plain)).svg]
    const compiled = [compileChart(structuredClone(de) as never), compileChart(structuredClone(inr) as never), compileChart(structuredClone(plain) as never)]
    for (let round = 0; round < 2; round++) {
      expect(diff(deWant, renderSpec(de as never)), `de ${round}`).toEqual([])
      expect(diff(inrWant, renderSpec(inr as never)), `inr ${round}`).toEqual([])
      expect(diff(plainWant, renderSpec(plain as never)), `plain ${round}`).toEqual([])
      for (const c of compiled) evaluateChart(c, {})
    }
    expect(defaultLocale().format('$,.2f')(1234.5)).toBe('$1,234.50')
  })

  it('a chart without one follows the default locale, and a chart with one keeps its own half over a changed default', async () => {
    defaultLocale({ decimal: ',', thousands: ' ', grouping: [3], currency: ['', ' CHF'] }, FR_TIME as never)
    vegaLocale.defaultLocale({ decimal: ',', thousands: ' ', grouping: [3], currency: ['', ' CHF'] }, FR_TIME)
    try {
      for (const locale of [undefined, { number: DE_NUMBER }, { time: { ...FR_TIME, months: FR_TIME.months.map((m) => m.toUpperCase()) } }]) {
        for (const [name, spec] of Object.entries(charts(locale))) {
          expect(diff((await oracle(spec)).svg, renderSpec(spec as never)), `${JSON.stringify(locale)} ${name}`).toEqual([])
        }
      }
    } finally {
      vegaLocale.resetDefaultLocale()
    }
  })
})

describe('Vega-Lite: config.locale is passed through', () => {
  const unit = (locale: Obj): Obj => ({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 160, height: 80, config: { locale },
    data: { values: rows.map((r) => ({ ...r, t: new Date(r.t).toISOString() })) }, mark: 'point',
    encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative', axis: { format: '$,.0f' } }, color: { field: 'v', type: 'quantitative' } },
  })
  for (const [which, locale] of Object.entries(LOCALES)) {
    if (!locale) continue
    it(which, async () => {
      const spec = unit(locale)
      expect(diff((await oracle(vegaLite.compile(spec as never).spec as Obj)).svg, renderSpec(compile(spec as never) as never))).toEqual([])
    })
  }
})
