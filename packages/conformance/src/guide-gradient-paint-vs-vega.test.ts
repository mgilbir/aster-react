// @vitest-environment jsdom
/**
 * A gradient object as the paint of a guide's part (an axis, a legend, a title; a view's own or a group mark's): vega-scenegraph
 * writes its definition in <defs> and the paint as a reference to it, as it does for a data mark. Every part that paints, the
 * gradient written in an encode block or given by a signal (and, painting nothing in either, set in the config), through the string renderer and the DOM
 * descriptors, against real vega.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>
const lin = { gradient: 'linear', x1: 0, y1: 1, x2: 1, y2: 0, stops: [{ offset: 0, color: 'white' }, { offset: 0.6, color: 'orange' }, { offset: 1, color: 'darkred' }] }
const rad = { gradient: 'radial', stops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'purple' }] }
const named = { gradient: 'linear', id: 'mine', x1: 0, y1: 0, x2: 0, y2: 1, stops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] }
const PAINTS: Array<[string, object]> = [['linear', lin], ['radial', rad], ['with an id of its own', named]]

const SCALES = [
  { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
  { name: 'y', type: 'linear', domain: [0, 5], range: 'height' },
  { name: 'c', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['tomato', 'steelblue', 'seagreen'] },
  { name: 'q', type: 'linear', domain: [0, 10], range: ['white', 'navy'] },
]
const FRAME = { width: 140, height: 90, padding: 5, autosize: 'none', scales: SCALES }

/** The parts of each guide and the paint channels they draw with, as `[guide kind, part, channels]`. */
const PARTS: Array<['axis' | 'symbol legend' | 'gradient legend' | 'title', string, string[]]> = [
  ['axis', 'domain', ['stroke']],
  ['axis', 'ticks', ['stroke']],
  ['axis', 'grid', ['stroke']],
  ['axis', 'labels', ['fill', 'stroke']],
  ['axis', 'title', ['fill']],
  ['axis', 'axis', ['fill', 'stroke']],
  ['symbol legend', 'symbols', ['fill', 'stroke']],
  ['symbol legend', 'labels', ['fill']],
  ['symbol legend', 'title', ['fill']],
  ['symbol legend', 'legend', ['fill', 'stroke']],
  ['symbol legend', 'entries', ['fill', 'stroke']],
  ['gradient legend', 'gradient', ['fill', 'stroke']],
  ['gradient legend', 'labels', ['fill']],
  ['title', 'title', ['fill']],
  ['title', 'subtitle', ['fill']],
  ['title', 'group', ['fill', 'stroke']],
]

/** The parts that are a guide's group items (vega draws each as a box). */
const GROUP_ITEMS = new Set(['axis', 'legend', 'entries', 'group'])

/** The guide of `kind`, with `encode` as its encode blocks. */
function guide(kind: string, encode: Spec): Spec {
  if (kind === 'axis') return { axes: [{ orient: 'bottom', scale: 'x', title: 'X', grid: true, encode }] }
  if (kind === 'symbol legend') return { legends: [{ fill: 'c', title: 'C', encode }] }
  if (kind === 'gradient legend') return { legends: [{ fill: 'q', type: 'gradient', title: 'Q', encode }] }
  return { title: { text: 'Title', subtitle: 'Sub', encode } }
}

/** As the view's own guide, and as the guide of a group mark. */
function placed(guideSpec: Spec, where: 'view' | 'group mark', extra: Spec = {}): Spec {
  if (where === 'view') return { ...FRAME, ...guideSpec, ...extra }
  return { ...FRAME, ...extra, marks: [{ type: 'group', encode: { update: { x: { value: 10 }, y: { value: 5 }, width: { value: 100 }, height: { value: 60 } } }, ...guideSpec }] }
}

async function vegaSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(spec as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

/** The differences between vega's SVG and Aster's, through the string renderer and through the DOM descriptors. */
async function differences(spec: Spec): Promise<{ string: string[]; dom: string[]; vegaWroteDefs: boolean }> {
  const want = await vegaSvg(structuredClone(spec))
  const scene = evaluateChart(compileChart(structuredClone(spec) as never))
  // (jsdom's serializer invents a prefix for the xlink namespace: the same attribute)
  const dom = new XMLSerializer().serializeToString(renderSceneToDomElement(scene, document) as unknown as Node)
    .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')
  const canon = canonicalizeSvg(want)
  return {
    string: diffCanonical(canon, canonicalizeSvg(renderSceneToSvg(scene))),
    dom: diffCanonical(canon, canonicalizeSvg(dom)),
    vegaWroteDefs: /<(linear|radial)Gradient/.test(want) && /(fill|stroke)="url\(#/.test(want),
  }
}

const NONE = { string: [], dom: [], vegaWroteDefs: true }

describe('gradient paints on guides vs vega', () => {
  for (const where of ['view', 'group mark'] as const) {
    for (const [kind, part, channels] of PARTS) {
      for (const [paintName, paint] of PAINTS) {
        it(`${where}: ${kind} ${part}, ${channels.join(' and ')} ${paintName}, in an encode block`, async () => {
          const update: Record<string, { value: unknown }> = Object.fromEntries(channels.map((c) => [c, { value: paint }]))
          // (a stroke draws with a width: the guide's group and a legend's symbols have none by default)
          if (channels.includes('stroke')) update.strokeWidth = { value: 2 }
          // (a guide's group item has no size of its own to paint: it is given one)
          if (GROUP_ITEMS.has(part)) Object.assign(update, { width: { value: 40 }, height: { value: 20 } })
          expect(await differences(placed(guide(kind, { [part]: { update } }), where))).toEqual(NONE)
        })
      }
    }
  }

  it('a signal that holds a gradient, on every guide kind', async () => {
    const enc = { update: { fill: { signal: 'paint' } } }
    const spec = {
      ...FRAME,
      signals: [{ name: 'paint', value: lin }],
      axes: [{ orient: 'left', scale: 'y', encode: { labels: enc } }],
      legends: [{ fill: 'c', encode: { labels: enc } }],
      title: { text: 'T', encode: { title: enc } },
    }
    expect(await differences(spec)).toEqual(NONE)
  })

  it('a gradient object set in the config, on every guide kind: vega paints with none of them, and neither does Aster', async () => {
    const spec = {
      ...FRAME,
      config: { axis: { domainColor: lin, labelColor: rad }, legend: { labelColor: lin, titleColor: rad }, title: { color: named } },
      axes: [{ orient: 'bottom', scale: 'x' }],
      legends: [{ fill: 'c', title: 'C' }],
      title: { text: 'T' },
    }
    expect(await differences(spec)).toEqual({ ...NONE, vegaWroteDefs: false })
  })
})
