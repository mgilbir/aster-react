// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import {
  defaultLocale,
  locale,
  resetDefaultLocale,
  renderSpec,
  setTextMetricsProvider,
  type FormatLocaleDefinition,
  type TimeLocaleDefinition,
  type TextMetricsProvider,
} from './index.js'
import type { VgSpec } from './types.js'

const deNumber: FormatLocaleDefinition = {
  decimal: ',', thousands: '.', grouping: [3], currency: ['', '\u00a0€'],
}
const deTime: TimeLocaleDefinition = {
  dateTime: '%A, der %e. %B %Y, %X', date: '%d.%m.%Y', time: '%H:%M:%S',
  periods: ['AM', 'PM'],
  days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  shortDays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  shortMonths: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
}
const frNumber: FormatLocaleDefinition = {
  decimal: ',', thousands: '\u202f', grouping: [3], currency: ['', '\u00a0€'],
}
const frTime: TimeLocaleDefinition = {
  dateTime: '%A %e %B %Y à %X', date: '%d/%m/%Y', time: '%H:%M:%S',
  periods: ['AM', 'PM'],
  days: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  shortDays: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
  months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  shortMonths: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
}
const arNumber: FormatLocaleDefinition = {
  decimal: '٫', thousands: '٬', grouping: [3], currency: ['', ' ج.م'],
  numerals: ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'],
  percent: '٪', minus: '−',
}
const jaNumber: FormatLocaleDefinition = { decimal: '.', thousands: ',', grouping: [3], currency: ['¥', ''] }
const jaTime: TimeLocaleDefinition = {
  dateTime: '%Y年%m月%d日 %H:%M:%S', date: '%Y年%m月%d日', time: '%H:%M:%S',
  periods: ['午前', '午後'],
  days: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  shortDays: ['日', '月', '火', '水', '木', '金', '土'],
  months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  shortMonths: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
}

afterEach(() => {
  resetDefaultLocale()
  setTextMetricsProvider(null)
})

describe('locale matrix', () => {
  it('formats numbers and dates per locale', () => {
    const cases: Array<{
      name: string
      number: FormatLocaleDefinition
      time?: TimeLocaleDefinition
      formats: Array<[string, number, string]>
      date: string
      month: string
    }> = [
      {
        name: 'de-DE', number: deNumber, time: deTime,
        formats: [[',.2f', 1234.5, '1.234,50'], ['$,.2f', 1234.5, '1.234,50\u00a0€'], ['.3s', 1234.5, '1,23k']],
        date: '%B %d %Y', month: 'März 05 2024',
      },
      {
        name: 'fr-FR', number: frNumber, time: frTime,
        formats: [[',.2f', 1234.5, '1\u202f234,50'], ['$,.2f', 1234.5, '1\u202f234,50\u00a0€']],
        date: '%d %B %Y', month: '05 mars 2024',
      },
      {
        name: 'ar-EG', number: arNumber, time: deTime,
        formats: [[',.1f', 1234.5, '١٬٢٣٤٫٥'], ['.2f', -12.5, '−١٢٫٥٠']],
        date: '', month: '',
      },
      {
        name: 'ja-JP', number: jaNumber, time: jaTime,
        formats: [[',.2f', 1234.5, '1,234.50'], ['$,.0f', 1234, '¥1,234']],
        date: '%Y年%m月%d日', month: '2024年03月05日',
      },
    ]
    for (const c of cases) {
      defaultLocale(c.number, c.time)
      const L = locale()
      for (const [spec, value, expected] of c.formats) expect(L.format(spec)(value), `${c.name} ${spec}`).toBe(expected)
      if (c.date) expect(L.timeFormat(c.date)(new Date(Date.UTC(2024, 2, 5))), c.name).toBe(c.month)
    }
    // round-trip parsing through the active locale
    defaultLocale(deNumber, deTime)
    expect(locale().timeParse('%d. %B %Y')('05. März 2024')?.toISOString()).toBe('2024-03-05T00:00:00.000Z')
    expect(locale().timeParse('%d. %B %Y')('05. März 2024')?.getUTCMonth()).toBe(2)
  })

  it('localizes rendered axis labels and titles', () => {
    const spec = {
      width: 300, height: 180, padding: 5, autosize: 'none',
      data: [{ name: 't', values: [
        { d: Date.UTC(2024, 0, 1), v: 1000 },
        { d: Date.UTC(2024, 1, 1), v: 2000 },
        { d: Date.UTC(2024, 2, 1), v: 1500 },
      ] }],
      scales: [
        { name: 'x', type: 'time', domain: { data: 't', field: 'd' }, range: 'width' },
        { name: 'y', type: 'linear', domain: [0, 2000], range: 'height' },
      ],
      axes: [
        { scale: 'x', orient: 'bottom', format: '%B', title: 'Monat' },
        { scale: 'y', orient: 'left', format: ',.0f', title: 'Wert' },
      ],
      marks: [{ type: 'line', from: { data: 't' }, encode: { update: {
        x: { scale: 'x', field: 'd' }, y: { scale: 'y', field: 'v' }, stroke: { value: 'steelblue' },
      } } }],
    } as unknown as VgSpec
    const en = renderSpec(spec)
    expect(en).toContain('January')
    defaultLocale(deNumber, deTime)
    const de = renderSpec(spec)
    expect(de).toContain('Januar')
    expect(de).toContain('Februar')
    expect(de).toContain('1.000')
    expect(de).not.toContain('January')
  })
})

const fontSpec = {
  width: 260, height: 160, padding: 5, autosize: 'none',
  title: { text: 'Custom font title', font: 'Inter' },
  data: [{ name: 't', values: [{ c: 'alpha', v: 3 }, { c: 'beta', v: 7 }, { c: 'gamma', v: 5 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
    { name: 'c', type: 'ordinal', domain: { data: 't', field: 'c' }, range: ['#4c78a8', '#f58518', '#54a24b'] },
  ],
  axes: [
    { scale: 'x', orient: 'bottom', title: 'Category', labelFont: 'Fira Code', titleFont: 'Inter' },
    { scale: 'y', orient: 'left', labelFont: 'Fira Code' },
  ],
  legends: [{ fill: 'c', title: 'Series', labelFont: 'Roboto' }],
  marks: [{
    type: 'rect', from: { data: 't' }, encode: { update: {
      x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
      y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { scale: 'c', field: 'c' },
    } },
  }, {
    type: 'text', from: { data: 't' }, encode: { update: {
      x: { scale: 'x', field: 'c', band: 0.5 }, y: { value: 10 }, text: { field: 'c' }, font: { value: 'Lato' },
    } },
  }],
} as unknown as VgSpec

const provider = (factor: number, seen?: Set<string>): TextMetricsProvider => ({
  measure: (text, font, fontSize) => {
    seen?.add(font)
    return text.length * fontSize * factor
  },
})

describe('custom font provider matrix', () => {
  it('passes the compiled font strings to the provider', () => {
    const seen = new Set<string>()
    renderSpec(fontSpec, { textMetrics: provider(0.8, seen) })
    expect([...seen].some((f) => f.includes('Inter'))).toBe(true)
    expect([...seen].some((f) => f.includes('Fira Code'))).toBe(true)
    expect([...seen].some((f) => f.includes('Lato'))).toBe(true)
    expect([...seen].some((f) => f.includes('Roboto'))).toBe(true)
  })

  it('measurably changes layout across narrow/normal/wide fonts', () => {
    const outs = [0.35, 0.8, 1.6].map((f) => renderSpec(fontSpec, { textMetrics: provider(f) }))
    expect(new Set(outs).size).toBe(3)
    // Wider fonts push the y-axis label/title stack further left (and grow the
    // legend/title boxes), so the rendered geometry differs monotonically.
    expect(outs[0]).not.toBe(outs[1])
    expect(outs[1]).not.toBe(outs[2])
  })

  it('invalid provider results fall back to the headless estimate', () => {
    const cases: TextMetricsProvider[] = [
      { measure: () => Number.NaN },
      { measure: () => -1 },
      { measure: () => { throw new Error('host failed') } },
    ]
    const baseline = renderSpec(fontSpec)
    for (const bad of cases) expect(renderSpec(fontSpec, { textMetrics: bad })).toBe(baseline)
  })

  it('caches per provider and invalidates when the provider changes', () => {
    const wide = provider(1.5)
    const narrow = provider(0.4)
    const a = renderSpec(fontSpec, { textMetrics: wide })
    const b = renderSpec(fontSpec, { textMetrics: narrow })
    const c = renderSpec(fontSpec, { textMetrics: wide })
    expect(a).not.toBe(b)
    expect(c).toBe(a)
  })
})
