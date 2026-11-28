/**
 * LIVE differential for `item` in encode expressions (C31): vega hands an encode's expressions the scenegraph item it is building
 * (the channels set so far, its datum, its mark and the group around it). Aster had `item` undefined everywhere: a text mark lost
 * its text, an axis whose label encode read `item.y` lost its domain and labels. The same specs are rendered by vega and Aster;
 * the canonical SVGs must be equal.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

type Spec = Record<string, unknown>

async function vegaSvg(spec: Spec): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const data = [{ name: 't', values: [{ n: 1, c: 'a' }, { n: 2, c: 'b' }, { n: 3, c: 'c' }] }]
const scales = [
  { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
  { name: 'col', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['red', 'green', 'blue'] },
]
const base = (marks: Spec[], extra: Spec = {}): Spec => ({ width: 100, height: 100, padding: 5, data, scales, marks, ...extra })
const text = (update: Spec, enter: Spec = { x: { value: 3 } }, name?: string): Spec => ({
  type: 'text', ...(name ? { name } : {}), from: { data: 't' }, encode: { enter, update: { y: { field: 'n', mult: 20 }, ...update } },
})

const CASES: Array<[string, Spec]> = [
  ['a channel set by enter', base([text({ text: { signal: "'row:' + item.x" } })])],
  ['the mark type, name and role', base([text({ text: { signal: "item.mark.marktype + '/' + item.mark.name + '/' + item.mark.role" } }, undefined, 'labels')])],
  ['the group around the mark', base([text({ text: { signal: "'w' + item.mark.group.width + 'h' + item.mark.group.height" } })])],
  ['the datum', base([text({ text: { signal: "'n' + item.datum.n" } })])],
  ['isDefined(item)', base([text({ text: { signal: "'' + isDefined(item)" } })])],
  ['an update channel read by a later one', base([text({ x: { value: 7 }, text: { signal: "'x' + item.x" } }, {})])],
  ['a rule test reading the item', base([{
    type: 'rect', from: { data: 't' }, encode: { enter: { width: { value: 10 }, height: { value: 10 } }, update: { x: { field: 'n', mult: 20 }, y: { value: 0 },
      fill: [{ test: 'item.x > 30', value: 'red' }, { value: 'blue' }] } },
  }])],
  ['a nested group\'s mark sees its group', base([{
    type: 'group', encode: { enter: { x: { value: 10 }, width: { value: 60 }, height: { value: 40 } } },
    marks: [text({ text: { signal: "'g' + item.mark.group.width" } })],
  }])],
  ['axis labels coloured by their position', base([], {
    axes: [{ scale: 'y', orient: 'left', tickCount: 2, encode: { labels: { update: { fill: { signal: "item.y > 50 ? 'red' : 'blue'" } } } } }],
  })],
  ['legend symbols reading their mark\'s role', base([], {
    legends: [{ fill: 'col', encode: { symbols: { update: { stroke: { signal: "item.mark.role == 'legend-symbol' ? 'black' : 'orange'" } } } } }],
  })],
]

describe('`item` in an encode is the scenegraph item being encoded (Aster vs real Vega)', () => {
  for (const [label, spec] of CASES) {
    it(label, async () => {
      const oracle = canonicalizeSvg(await vegaSvg(spec))
      const svg = renderSpec(structuredClone(spec) as never)
      expect(diffCanonical(oracle, canonicalizeSvg(svg))).toEqual([])
    })
  }
})
