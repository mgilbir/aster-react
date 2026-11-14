// @vitest-environment node
/**
 * A dataset whose `values` is a `{signal}` is loaded by vega's dynamic loader, which ingests the rows the signal gives without
 * keeping the `{data}` wrapper a primitive gets elsewhere: a primitive tuple is the number or string itself (`datum` is 2,
 * `datum.data` is undefined, `data("t")` holds 2). The values are code: the chart renders them through `renderSpec`, through a
 * session (what <Chart> evaluates with), after an edit of the expression, and through a stream, as vega renders them.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec, renderSceneToSvg, createChartStream } from '@aster-charts/core'
import { createChartSession } from '@aster-charts/core/dom'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const text = (y: string, t: string): any => ({ type: 'text', from: { data: 't' }, encode: { update: { x: { value: 5 }, y: { signal: y }, text: { signal: t }, fontSize: { value: 9 } } } })
const spec = (values: unknown, marks: unknown[], extra: Record<string, unknown> = {}): any => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json', width: 120, height: 80, padding: 5, autosize: 'none',
  ...extra,
  data: [{ name: 't', values }, ...((extra.data as unknown[]) ?? [])],
  marks,
})

const CASES: Record<string, any> = {
  'numbers: datum is the number, datum.data is undefined': spec({ signal: 'sequence(1, 4)' }, [text('10 * datum', '"v" + datum + "/" + datum.data')]),
  'strings: datum.length is the string\'s': spec({ signal: '["a", "bcd", "ef"]' }, [text('10 + 20 * indexof(data("t"), datum)', 'datum + ":" + datum.length')]),
  'objects and primitives mixed': spec({ signal: '[{a: 1}, 5, "x", {a: 2, data: 7}]' }, [text('isObject(datum) ? 10 * datum.a : 40', '"a=" + datum.a + " d=" + datum.data + " v=" + datum')]),
  'a filter and an aggregate over primitive tuples': {
    ...spec({ signal: 'sequence(0, 6)' }, [
      text('10 + 8 * datum', '"kept " + datum'),
      { type: 'text', from: { data: 'n' }, encode: { update: { x: { value: 60 }, y: { value: 20 }, text: { signal: '"count " + datum.count' } } } },
    ]),
    data: [
      { name: 't', values: { signal: 'sequence(0, 6)' }, transform: [{ type: 'filter', expr: 'datum % 2 == 0' }] },
      { name: 'n', source: 't', transform: [{ type: 'aggregate' }] },
    ],
  },
  // (vega keys a mark's items by tuple id, which a primitive tuple has not: all of them are one item, where the first is, with the
  // last as its datum)
  'several primitives are one item': spec({ signal: '[5, 6, 7]' }, [text('20', '"<" + datum + ">"')]),
  'primitives among objects': spec({ signal: '[5, {a: 1}, 6, {a: 2}, 7]' }, [text('isObject(datum) ? 10 + 20 * datum.a : 70', '"<" + (isObject(datum) ? datum.a : datum) + ">"')]),
  'data() of a signal-valued dataset, read by a signal': spec({ signal: 'sequence(3, 6)' }, [
    { type: 'text', encode: { update: { x: { value: 5 }, y: { value: 20 }, text: { signal: 'length(data("t")) + " first " + data("t")[0] + " sum " + (data("t")[0] + data("t")[1])' } } } },
  ]),
  'the values read another signal': spec({ signal: 'sequence(0, n)' }, [text('10 + 10 * datum', '"i" + datum')], { signals: [{ name: 'n', value: 4 }] }),
}

const clean = (s: any): any => JSON.parse(JSON.stringify(s))
async function oracle(s: any): Promise<string> {
  const vega = await renderWithVegaChecked(clean(s))
  expect(vega.errors).toEqual([])
  return canonicalizeSvg(vega.svg)
}
function logged(): { errors: unknown[]; logger: any } {
  const errors: unknown[] = []
  return { errors, logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } }
}

describe('signal-valued values render as vega renders them', () => {
  for (const [name, s] of Object.entries(CASES)) {
    it(`${name}: renderSpec, a session, a stream`, async () => {
      const want = await oracle(s)
      const { errors, logger } = logged()
      expect(diffCanonical(want, canonicalizeSvg(renderSpec(clean(s), { logger } as never) as string)).slice(0, 3), 'renderSpec').toEqual([])
      const session = createChartSession()
      expect(diffCanonical(want, canonicalizeSvg(renderSceneToSvg(session.evaluate(clean(s), { logger } as never)))).slice(0, 3), 'session').toEqual([])
      const stream = createChartStream(clean(s))
      stream.push({ signals: {} })
      expect(stream.flush()).not.toBeNull()
      expect(diffCanonical(want, canonicalizeSvg(renderSceneToSvg(stream.scene()!))).slice(0, 3), 'stream').toEqual([])
      stream.close()
      expect(errors).toEqual([])
    }, 30_000)
  }

  it('a session follows an edit of the expression (the values are part of the chart, not rows)', async () => {
    const session = createChartSession()
    const a = spec({ signal: 'sequence(1, 4)' }, [text('10 * datum', '"v" + datum')])
    const b = spec({ signal: 'sequence(5, 9)' }, [text('10 * datum - 40', '"v" + datum')])
    session.evaluate(clean(a))
    expect(diffCanonical(await oracle(b), canonicalizeSvg(renderSceneToSvg(session.evaluate(clean(b))))).slice(0, 3)).toEqual([])
  }, 30_000)
})
