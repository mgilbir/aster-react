/**
 * The cases of the label differential (vl-timeunit-labels-*.test.ts): every local and every UTC time unit of the schema, as strings
 * and as objects, in every place a spec can put one, and the text each compiled spec draws.
 */
import { createRequire } from 'node:module'
import * as vega from 'vega'
import { TIME_DATA, bothCompile } from './vl-time-helpers.js'

const require = createRequire(import.meta.url)
const schema = require('vega-lite/vega-lite-schema.json').definitions
const LOCAL: string[] = [...schema.LocalSingleTimeUnit.enum, ...schema.LocalMultiTimeUnit.enum]
const UTC: string[] = [...schema.UtcSingleTimeUnit.enum, ...schema.UtcMultiTimeUnit.enum]

export const UNITS: Array<[string, unknown]> = [
  ...LOCAL.map((u): [string, unknown] => [u, u]),
  ...UTC.map((u): [string, unknown] => [u, u]),
  ...['year', 'month', 'date', 'hours', 'yearmonth', 'yearmonthdate', 'day'].map((u): [string, unknown] => [`{unit: ${u}, utc}`, { unit: u, utc: true }]),
  ...['year', 'month', 'yearmonthdate'].map((u): [string, unknown] => [`{unit: ${u}, step: 2}`, { unit: u, step: 2 }]),
  ...['month', 'hours'].map((u): [string, unknown] => [`{unit: ${u}, utc, step: 3}`, { unit: u, utc: true, step: 3 }]),
]

/** Zones, and the offset (in minutes, behind UTC) each has on 1 July 2020: a zone that did not take effect fails the test, not passes it. */
export const ZONES: Array<[string, number]> = [['UTC', 0], ['America/New_York', 240], ['Asia/Kolkata', -330], ['Australia/Lord_Howe', -630]]

const VALUE = { field: 'v', type: 'quantitative' }
type Make = (unit: unknown) => Record<string, unknown>
const T = (unit: unknown, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ field: 't', type, timeUnit: unit, ...extra })
const unitSpec = (mark: unknown, encoding: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data: { values: TIME_DATA }, mark, encoding, ...extra })

export const FORMS: Array<[string, Make]> = [
  ['x temporal', (u) => unitSpec('point', { x: T(u, 'temporal'), y: VALUE })],
  ['x temporal, utc scale', (u) => unitSpec('point', { x: T(u, 'temporal', { scale: { type: 'utc' } }), y: VALUE })],
  ['x temporal, time scale', (u) => unitSpec('point', { x: T(u, 'temporal', { scale: { type: 'time' } }), y: VALUE })],
  ['x temporal, a domain', (u) => unitSpec('point', { x: T(u, 'temporal', { scale: { domain: [{ year: 2020, month: 1, date: 1 }, { year: 2021, month: 6, date: 1 }] } }), y: VALUE })],
  ['x temporal, a utc domain', (u) => unitSpec('point', { x: T(u, 'temporal', { scale: { domain: [{ year: 2020, month: 1, date: 1, utc: true }, { year: 2021, month: 6, date: 1, utc: true }] } }), y: VALUE })],
  ['x temporal, nice', (u) => unitSpec('line', { x: T(u, 'temporal', { scale: { nice: 'month' } }), y: VALUE })],
  ['x temporal, a format', (u) => unitSpec('point', { x: T(u, 'temporal', { axis: { format: '%b %Y' } }), y: VALUE })],
  ['x temporal, a formatType', (u) => unitSpec('point', { x: T(u, 'temporal', { axis: { formatType: 'time' } }), y: VALUE })],
  ['x temporal, labelAngle', (u) => unitSpec('point', { x: T(u, 'temporal', { axis: { labelAngle: -45 } }), y: VALUE })],
  ['x ordinal', (u) => unitSpec('point', { x: T(u, 'ordinal'), y: VALUE })],
  ['x nominal', (u) => unitSpec('point', { x: T(u, 'nominal'), y: VALUE })],
  ['x quantitative', (u) => unitSpec('point', { x: T(u, 'quantitative'), y: VALUE })],
  ['x ordinal, a format', (u) => unitSpec('point', { x: T(u, 'ordinal', { axis: { format: '%b %Y' } }), y: VALUE })],
  ['x ordinal, a formatType', (u) => unitSpec('point', { x: T(u, 'ordinal', { axis: { formatType: 'time' } }), y: VALUE })],
  ['y temporal', (u) => unitSpec('point', { y: T(u, 'temporal'), x: VALUE })],
  ['y ordinal', (u) => unitSpec('point', { y: T(u, 'ordinal'), x: VALUE })],
  ['bar over an ordinal', (u) => unitSpec('bar', { x: T(u, 'ordinal'), y: { aggregate: 'sum', ...VALUE } })],
  ['bar over a temporal', (u) => unitSpec('bar', { x: T(u, 'temporal'), y: { aggregate: 'sum', ...VALUE } })],
  ['bar, band position', (u) => unitSpec({ type: 'bar', width: { band: 0.8 } }, { x: T(u, 'temporal', { bandPosition: 0 }), y: { aggregate: 'sum', ...VALUE } })],
  ['color temporal', (u) => unitSpec('point', { x: VALUE, color: T(u, 'temporal') })],
  ['color ordinal', (u) => unitSpec('point', { x: VALUE, color: T(u, 'ordinal') })],
  ['color nominal', (u) => unitSpec('point', { x: VALUE, color: T(u, 'nominal') })],
  ['color ordinal, a formatType', (u) => unitSpec('point', { x: VALUE, color: T(u, 'ordinal', { legend: { formatType: 'time' } }) })],
  ['color ordinal, a format', (u) => unitSpec('point', { x: VALUE, color: T(u, 'ordinal', { legend: { format: '%b %Y' } }) })],
  ['color temporal, a format', (u) => unitSpec('point', { x: VALUE, color: T(u, 'temporal', { legend: { format: '%b %Y' } }) })],
  ['color temporal, a utc scale', (u) => unitSpec('point', { x: VALUE, color: T(u, 'temporal', { scale: { type: 'utc' } }) })],
  ['color ordinal, a time scale', (u) => unitSpec('point', { x: VALUE, color: T(u, 'ordinal', { scale: { type: 'time' } }) })],
  ['x ordinal, a utc scale', (u) => unitSpec('point', { x: T(u, 'ordinal', { scale: { type: 'utc' } }), y: VALUE })],
  ['size ordinal', (u) => unitSpec('point', { x: VALUE, size: T(u, 'ordinal') })],
  ['size temporal', (u) => unitSpec('point', { x: VALUE, size: T(u, 'temporal') })],
  ['shape nominal', (u) => unitSpec('point', { x: VALUE, shape: T(u, 'nominal') })],
  ['opacity ordinal', (u) => unitSpec('point', { x: VALUE, opacity: T(u, 'ordinal') })],
  ['strokeDash ordinal', (u) => unitSpec('line', { x: VALUE, y: VALUE, strokeDash: T(u, 'ordinal') })],
  ['color and shape', (u) => unitSpec('point', { x: VALUE, color: T(u, 'ordinal'), shape: T(u, 'ordinal') })],
  ['text temporal', (u) => unitSpec('text', { x: VALUE, text: T(u, 'temporal') })],
  ['text ordinal', (u) => unitSpec('text', { x: VALUE, text: T(u, 'ordinal') })],
  ['text, a format', (u) => unitSpec('text', { x: VALUE, text: T(u, 'temporal', { format: '%b %Y' }) })],
  ['text, a formatType', (u) => unitSpec('text', { x: VALUE, text: T(u, 'ordinal', { formatType: 'time' }) })],
  ['text, a utc scale', (u) => unitSpec('text', { x: VALUE, text: T(u, 'temporal', { scale: { type: 'utc' } }) })],
  ['tooltip temporal', (u) => unitSpec('point', { x: VALUE, tooltip: T(u, 'temporal') })],
  ['tooltip ordinal', (u) => unitSpec('point', { x: VALUE, tooltip: T(u, 'ordinal') })],
  ['tooltip, a format', (u) => unitSpec('point', { x: VALUE, tooltip: T(u, 'temporal', { format: '%b %Y' }) })],
  ['tooltip array', (u) => unitSpec('point', { x: VALUE, tooltip: [T(u, 'temporal'), VALUE] })],
  ['row temporal', (u) => unitSpec('point', { x: VALUE, row: T(u, 'temporal') })],
  ['row ordinal', (u) => unitSpec('point', { x: VALUE, row: T(u, 'ordinal') })],
  ['column ordinal, a header format', (u) => unitSpec('point', { x: VALUE, column: T(u, 'ordinal', { header: { format: '%b %Y' } }) })],
  ['column ordinal, a header formatType', (u) => unitSpec('point', { x: VALUE, column: T(u, 'ordinal', { header: { formatType: 'time' } }) })],
  ['facet', (u) => ({ data: { values: TIME_DATA }, facet: { field: 't', type: 'ordinal', timeUnit: u }, columns: 2, spec: { mark: 'point', encoding: { x: VALUE } } })],
  ['layer', (u) => ({ data: { values: TIME_DATA }, layer: [{ mark: 'line', encoding: { x: T(u, 'temporal'), y: VALUE } }, { mark: 'point', encoding: { x: T(u, 'temporal'), y: VALUE, color: T(u, 'ordinal') } }] })],
  ['layer, text', (u) => ({ data: { values: TIME_DATA }, layer: [{ mark: 'bar', encoding: { x: T(u, 'ordinal'), y: VALUE } }, { mark: 'text', encoding: { x: T(u, 'ordinal'), y: VALUE, text: T(u, 'ordinal') } }] })],
  ['concat', (u) => ({ data: { values: TIME_DATA }, hconcat: [{ mark: 'point', encoding: { x: T(u, 'ordinal'), y: VALUE } }, { mark: 'point', encoding: { x: VALUE, color: T(u, 'temporal') } }] })],
  ['boxplot', (u) => unitSpec('boxplot', { x: T(u, 'ordinal'), y: VALUE })],
  ['boxplot, temporal', (u) => unitSpec('boxplot', { x: T(u, 'temporal'), y: VALUE })],
  ['boxplot, colour and tooltip', (u) => unitSpec('boxplot', { x: { field: 'k', type: 'ordinal' }, y: VALUE, color: T(u, 'ordinal'), tooltip: T(u, 'ordinal') })],
  ['errorbar, temporal', (u) => unitSpec('errorbar', { x: T(u, 'temporal'), y: VALUE })],
  ['errorband, temporal', (u) => unitSpec('errorband', { x: T(u, 'temporal'), y: VALUE })],
  ['errorbar, y', (u) => unitSpec('errorbar', { y: T(u, 'ordinal'), x: VALUE })],
  ['errorbar', (u) => unitSpec('errorbar', { x: T(u, 'ordinal'), y: VALUE })],
  ['rect heatmap', (u) => unitSpec('rect', { x: T(u, 'ordinal'), y: { field: 'k', type: 'ordinal' }, color: { aggregate: 'sum', ...VALUE } })],
  ['theta', (u) => unitSpec('arc', { theta: { aggregate: 'sum', ...VALUE }, color: T(u, 'ordinal') })],
  ['transform timeUnit', (u) => ({ data: { values: TIME_DATA }, transform: [{ timeUnit: u, field: 't', as: 'u' }], mark: 'point', encoding: { x: { field: 'u', type: 'temporal' }, y: VALUE } })],
  ['transform timeUnit, ordinal', (u) => ({ data: { values: TIME_DATA }, transform: [{ timeUnit: u, field: 't', as: 'u' }], mark: 'point', encoding: { x: { field: 'u', type: 'ordinal' }, y: VALUE } })],
]

/** Every piece of text a spec draws and every tooltip and description it computes, in scene order: one string per item. */
export async function drawn(vg: any): Promise<string[]> {
  const view = new vega.View(vega.parse(JSON.parse(JSON.stringify(vg))), { renderer: 'none' })
  await view.runAsync()
  const out: string[] = []
  const walk = (node: any, role: string): void => {
    if (node === null || typeof node !== 'object') return
    for (const item of node.items ?? []) {
      for (const key of ['text', 'tooltip', 'description']) {
        if (item[key] !== undefined && item[key] !== null) out.push(`${role}.${key}=${JSON.stringify(item[key])}`)
      }
      walk(item, role)
    }
    for (const sub of node.marks ?? []) walk(sub, sub.role ?? sub.marktype ?? role)
  }
  walk(view.scenegraph().root, 'root')
  const svg = await view.toSVG()
  for (const m of svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) out.push(`svg=${m[1]}`)
  return out
}


/** Compile `make(unit)` both ways for every unit and report the units whose drawn text differs, in the zone this process is in. */
export async function labelDifferences(make: Make): Promise<string[]> {
  const bad: string[] = []
  for (const [name, unit] of UNITS) {
    const both = bothCompile(make(unit))
    if ('refusedBy' in both) {
      if (both.refusedBy === 'aster') bad.push(`${name}: refused by aster only`)
      continue
    }
    const theirs = await drawn(both.theirs)
    const ours = await drawn(both.ours)
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
      const i = theirs.findIndex((s, k) => s !== ours[k])
      bad.push(`${name}: expected ${theirs[i] ?? '(nothing)'} got ${ours[i] ?? '(nothing)'}`)
    }
  }
  return bad
}
