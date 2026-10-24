// @vitest-environment node
/**
 * Vega-Lite's custom format types, against vega-lite + real vega. `formatType: "price"` compiles to a call of the
 * expression function `price(...)`, which both vega (`expressionFunction`) and Aster (`registerExpressionFunction`)
 * resolve against what the host registered. A custom type is honoured only with `config.customFormatTypes: true`
 * (otherwise it is dropped with its format); the built-in "number" and "time" always are.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compile as vlCompile } from 'vega-lite'
import { compile } from '@aster/vl'
import { renderSpec, registerExpressionFunction } from '@aster/core'
import '@aster/core/transforms'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Obj = Record<string, unknown>
const price = (v: unknown, fmt?: string): string => `[${fmt ?? ''}:${v}]`
const when = (v: unknown, fmt?: string): string => `<${fmt ?? ''}|${new Date(v as number).getUTCFullYear()}>`
const offs: Array<() => void> = []
beforeAll(() => {
  const ef = (vega as unknown as { expressionFunction: (n: string, f: unknown) => void }).expressionFunction
  ef('asterPrice', price)
  ef('asterWhen', when)
  offs.push(registerExpressionFunction('asterPrice', price as never), registerExpressionFunction('asterWhen', when as never))
})
afterAll(() => { for (const off of offs) off() })

const DATA = { values: [{ c: 'alpha', v: 28, w: 3, t: '2024-01-07', g: 'p' }, { c: 'beta', v: 55, w: 7, t: '2024-03-19', g: 'q' }, { c: 'gamma', v: 43, w: 5, t: '2024-06-02', g: 'p' }] }
const unit = (mark: string, encoding: Obj, config?: Obj): Obj => ({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: DATA, mark, encoding, ...(config ? { config } : {}) })
const FLAG = { customFormatTypes: true }

async function svgOf(vg: unknown): Promise<string> {
  const log = console.error
  console.error = () => {}
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(vg as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { console.error = log; view.finalize() }
}

const X = { field: 'c', type: 'nominal' }
const Y = { field: 'v', type: 'quantitative' }
const CASES: Array<[string, Obj]> = [
  ['text: a custom type with the flag', unit('text', { x: X, y: Y, text: { field: 'v', type: 'quantitative', formatType: 'asterPrice', format: '$.2f' } }, FLAG)],
  ['text: a custom type with no format', unit('text', { x: X, y: Y, text: { field: 'v', type: 'quantitative', formatType: 'asterPrice' } }, FLAG)],
  ['text: a custom type without the flag is dropped, format and all', unit('text', { x: X, y: Y, text: { field: 'v', type: 'quantitative', formatType: 'asterPrice', format: '$.2f' } })],
  ['text: formatType number', unit('text', { x: X, y: Y, text: { field: 'v', type: 'quantitative', formatType: 'number', format: '.1f' } })],
  ['text: formatType number, no format', unit('text', { x: X, y: Y, text: { field: 'v', type: 'quantitative', formatType: 'number' } })],
  ['text: formatType time on a temporal field', unit('text', { x: X, y: Y, text: { field: 't', type: 'temporal', formatType: 'time', format: '%b' } })],
  ['text: formatType time on a quantitative field', unit('text', { x: X, y: Y, text: { field: 'v', type: 'quantitative', formatType: 'time', format: '%Y' } })],
  ['description: a custom type', unit('point', { x: X, y: Y, description: { field: 'v', type: 'quantitative', formatType: 'asterPrice', format: 'usd' } }, FLAG)],
  ['href: a custom type', unit('point', { x: X, y: Y, href: { field: 'c', type: 'nominal', formatType: 'asterPrice' } }, FLAG)],
  ['config: numberFormatType on a text channel', unit('text', { x: X, y: Y, text: { field: 'v', type: 'quantitative' } }, { ...FLAG, numberFormatType: 'asterPrice', numberFormat: '$.1f' })],
  ['config: timeFormatType on a text channel', unit('text', { x: X, y: Y, text: { field: 't', type: 'temporal' } }, { ...FLAG, timeFormatType: 'asterWhen', timeFormat: '%b' })],
  ['config: timeFormatType with a time unit stays a time format', unit('text', { x: X, y: Y, text: { field: 't', type: 'temporal', timeUnit: 'month' } }, { ...FLAG, timeFormatType: 'asterWhen', timeFormat: '%b' })],
  ['config: numberFormatType without the flag does nothing', unit('text', { x: X, y: Y, text: { field: 'v', type: 'quantitative' } }, { numberFormatType: 'asterPrice', numberFormat: '$.1f' })],
  ['config: normalizedNumberFormatType alone changes nothing', unit('bar', { x: X, y: Y }, { normalizedNumberFormatType: 'Aa' })],
  ['axis: a custom format type', unit('point', { x: X, y: { ...Y, axis: { formatType: 'asterPrice', format: '$.2f' } } }, FLAG)],
  ['axis: a custom type without the flag is dropped', unit('point', { x: X, y: { ...Y, axis: { formatType: 'asterPrice', format: '$.2f' } } })],
  ['axis: config numberFormatType', unit('point', { x: X, y: Y }, { ...FLAG, numberFormatType: 'asterPrice', numberFormat: '$.1f' })],
  ['axis: a format of its own beats the config type', unit('point', { x: X, y: { ...Y, axis: { format: '.1f' } } }, { ...FLAG, numberFormatType: 'asterPrice' })],
  ['axis: normalized stack with normalizedNumberFormatType', unit('bar', { x: X, y: { ...Y, stack: 'normalize' } }, { ...FLAG, normalizedNumberFormatType: 'asterPrice', normalizedNumberFormat: '.0%' })],
  ['axis: normalized stack falls back to numberFormatType', unit('bar', { x: X, y: { ...Y, stack: 'normalize' } }, { ...FLAG, numberFormatType: 'asterPrice', numberFormat: '.1f' })],
  ['axis: timeFormatType on a temporal axis', unit('point', { x: { field: 't', type: 'temporal' }, y: Y }, { ...FLAG, timeFormatType: 'asterWhen', timeFormat: '%b' })],
  ['axis: a custom label expression beats the custom type', unit('point', { x: X, y: { ...Y, axis: { formatType: 'asterPrice', labelExpr: '"L" + datum.label' } } }, FLAG)],
  ['legend: a custom format type', unit('point', { x: X, y: Y, color: { field: 'w', type: 'quantitative', legend: { formatType: 'asterPrice', format: '$.2f' } } }, FLAG)],
  ['legend: a custom type on a nominal field', unit('point', { x: X, y: Y, color: { field: 'g', type: 'nominal', legend: { formatType: 'asterPrice', format: 'g' } } }, FLAG)],
  ['legend: config numberFormatType', unit('point', { x: X, y: Y, color: { field: 'w', type: 'quantitative' } }, { ...FLAG, numberFormatType: 'asterPrice', numberFormat: '$.1f' })],
  ['legend: a custom type without the flag is dropped', unit('point', { x: X, y: Y, color: { field: 'w', type: 'quantitative', legend: { formatType: 'asterPrice', format: '$.2f' } } })],
  ['size legend: a custom format type', unit('point', { x: X, y: Y, size: { field: 'w', type: 'quantitative', legend: { formatType: 'asterPrice' } } }, FLAG)],
  ['header: a custom format type needs no flag', unit('point', { x: X, y: Y, row: { field: 'g', type: 'nominal', header: { formatType: 'asterPrice', format: 'h' } } })],
]

describe('custom format types', () => {
  for (const [label, spec] of CASES) {
    it(label, async () => {
      const oracle = vlCompile(spec as never).spec as unknown
      const ours = compile(spec as never) as unknown
      expect(diffCanonical(canonicalizeSvg(await svgOf(oracle)), canonicalizeSvg(renderSpec(ours as never)))).toEqual([])
      // vega renders what Aster's compiler emitted the same as what vega-lite's did
      expect(diffCanonical(canonicalizeSvg(await svgOf(oracle)), canonicalizeSvg(await svgOf(ours)))).toEqual([])
    })
  }

  it('the registered function really is what is called (the oracle is not rendering the same default twice)', async () => {
    const svg = renderSpec(compile(CASES[0]![1] as never) as never)
    expect(svg).toContain('[$.2f:28]')
  })
})
