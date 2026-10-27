// @vitest-environment jsdom
/**
 * The `encode` blocks of every part of every guide, against real Vega.
 *
 * An axis is made of a group and five marks (grid, ticks, labels, domain, title); a legend of a group, an entry group, a
 * title and either a gradient with its labels, the bands of a discretizing scale with their labels, or one symbol and one
 * label per entry (`encode.legend`, `.title`, `.labels`, `.symbols`, `.entries`, `.gradient`); a title of a group, the
 * text and the subtitle (`encode.group`, `.title`, `.subtitle`). Vega runs a part's `enter` block, then its `update`
 * block over it, each block being the guide's own channels overridden entry by entry by the spec's: so a channel the guide
 * keeps in `update` (a position, a text, an anchor) cannot be moved from `enter`, and one it keeps in `enter` can. Every
 * part is walked through the channels a mark has, in each block and in both, and through the `name`, `interactive` and
 * `style` the spec may give it; the strict canonicalizer judges the documents, the DOM renderer must draw the same one.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSpec } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const log = console.error
  console.error = () => {}
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    console.error = log
    view.finalize()
  }
}
const domSvg = (spec: Spec): string => new XMLSerializer().serializeToString(renderSceneToDomElement(evaluateChart(compileChart(spec as never)), document) as unknown as Node)
  .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')

/**
 * What the oracle itself refuses (`vega.parse` throws): there is nothing to agree with. Counted, like the sweeps' node
 * errors, and held to a ceiling at the end.
 */
const refused: string[] = []

/** Every difference between vega and the string renderer (and the DOM renderer) for `spec`; [] when they agree. */
async function differences(spec: Spec, dom = true): Promise<string[]> {
  let svg: string
  try {
    svg = await oracleSvg(spec)
  } catch (e) {
    refused.push((e as Error).message.split('\n')[0]!)
    return []
  }
  const want = canonicalizeSvg(svg)
  const out = diffCanonical(want, canonicalizeSvg(renderSpec(spec as never)))
  if (out.length || !dom) return out
  return diffCanonical(want, canonicalizeSvg(domSvg(spec))).map((d) => `dom: ${d}`)
}

/** The channels a mark can be given by an encode block, each with a value that moves or paints it visibly. */
const CHANNELS: Record<string, unknown> = {
  fill: { value: 'orange' }, stroke: { value: 'purple' }, strokeWidth: { value: 3 }, opacity: { value: 0.5 }, strokeDash: { value: [2, 2] },
  fillOpacity: { value: 0.4 }, strokeOpacity: { value: 0.3 }, strokeCap: { value: 'round' }, strokeDashOffset: { value: 2 },
  x: { value: 3 }, y: { value: 4 }, x2: { value: 20 }, y2: { value: 20 }, xc: { value: 12 }, yc: { value: 12 }, width: { value: 30 }, height: { value: 30 },
  dx: { value: 2 }, dy: { value: 2 }, angle: { value: 20 }, cornerRadius: { value: 4 },
  size: { value: 300 }, shape: { value: 'square' },
  text: { value: 'zz' }, baseline: { value: 'top' }, align: { value: 'center' }, limit: { value: 12 }, font: { value: 'serif' },
  fontSize: { value: 15 }, fontWeight: { value: 'normal' }, fontStyle: { value: 'italic' }, lineHeight: { value: 20 },
  href: { value: 'http://x/' }, description: { value: 'D' }, aria: { value: false }, ariaRole: { value: 'img' }, ariaRoleDescription: { value: 'rd' },
  cursor: { value: 'pointer' }, zindex: { value: 1 },
}
const SIGNALLED: Record<string, unknown> = {
  // the same channels from signals and expressions: they land in `update` however they are written
  fill: { signal: '"teal"' }, x: { signal: '3 + 4' }, text: { signal: '"from " + "a signal"' }, opacity: { signal: '0.25' }, angle: { signal: 'null' },
  fontSize: { signal: 'null' }, strokeWidth: { signal: '0' }, size: { signal: 'null' }, baseline: { signal: '"bottom"' },
}

const ROWS = [{ k: 'a', v: 28 }, { k: 'b', v: 55 }, { k: 'c', v: 43 }]
const frame = (extra: Spec): Spec => ({ width: 100, height: 80, padding: 5, autosize: 'none', data: [{ name: 't', values: ROWS }], ...extra })

/** Walk one part through every channel in `enter`, in `update`, and in both with different values (the later block wins). */
function matrix(label: string, parts: string[], make: (part: string, encode: Spec) => Spec): void {
  for (const part of parts) {
    it(`${label}: encode.${part}, every channel in enter, in update, from signals, and in both`, async () => {
      const bad: string[] = []
      const run = async (what: string, spec: Spec): Promise<void> => {
        const d = await differences(spec)
        if (d.length) bad.push(`${what}: ${d[0]}`)
      }
      for (const [name, v] of Object.entries(CHANNELS)) {
        await run(`enter.${name}`, make(part, { [part]: { enter: { [name]: v } } }))
        await run(`update.${name}`, make(part, { [part]: { update: { [name]: v } } }))
      }
      for (const [name, v] of Object.entries(SIGNALLED)) {
        await run(`enter.${name} (signal)`, make(part, { [part]: { enter: { [name]: v } } }))
        await run(`update.${name} (signal)`, make(part, { [part]: { update: { [name]: v } } }))
      }
      // enter and update that disagree: update is the one drawn
      await run('x in enter, y in update', make(part, { [part]: { enter: { x: { value: 9 }, fill: { value: 'red' } }, update: { y: { value: 7 }, fill: { value: 'blue' } } } }))
      // a block that also names the guide's own keys
      await run('opacity and the text in both', make(part, { [part]: { enter: { opacity: { value: 0.2 }, text: { value: 'E' } }, update: { opacity: { value: 0.8 }, text: { value: 'U' } } } }))
      expect(bad).toEqual([])
    }, 300_000)
  }
}

/** The extras of a part (vega's guideMark): its name, interactivity and style. */
function extras(label: string, parts: string[], make: (part: string, block: Spec) => Spec): void {
  for (const part of parts) {
    it(`${label}: encode.${part} name, interactive and style`, async () => {
      const cfg = { style: { 'my-style': { fill: 'seagreen', stroke: 'navy', fontSize: 17, font: 'monospace', strokeWidth: 3, opacity: 0.6, strokeDash: [3, 1] }, 'other-style': { fill: 'crimson', size: 150 } } }
      const blocks: Array<[string, Spec]> = [
        ['a name', { name: 'my-name' }],
        ['a name with a space', { name: 'a b' }],
        ['interactive', { interactive: true }],
        ['not interactive', { interactive: false }],
        ['a style', { style: 'my-style' }],
        ['two styles', { style: ['my-style', 'other-style'] }],
        ['a style nobody defined', { style: 'nothing-defined' }],
        ['all three, and a channel of its own', { name: 'n', interactive: true, style: 'my-style', update: { opacity: { value: 0.9 } } }],
      ]
      const bad: string[] = []
      for (const [what, block] of blocks) {
        const d = await differences({ ...make(part, block), config: cfg })
        if (d.length) bad.push(`${what}: ${d[0]}`)
      }
      expect(bad).toEqual([])
    }, 300_000)
  }
}

const SCALES = [
  { name: 'x', type: 'band', domain: ['a', 'b', 'c'], range: 'width' },
  { name: 'y', type: 'linear', domain: [0, 1], range: 'height' },
  { name: 'cat', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'green'] },
  { name: 'lin', type: 'linear', domain: [0, 10], range: ['white', 'black'] },
  { name: 'size', type: 'linear', domain: [0, 10], range: [20, 200] },
  { name: 'qz', type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] },
  { name: 'th', type: 'threshold', domain: [3, 6], range: ['#eee', '#9bd', '#06c'] },
]

describe('axis parts', () => {
  const AXIS_PARTS = ['axis', 'grid', 'ticks', 'labels', 'domain', 'title']
  const axis = (orient: string, encode: Spec): Spec => frame({
    scales: SCALES, axes: [{ orient, scale: orient === 'bottom' || orient === 'top' ? 'x' : 'y', title: 'T', grid: true, encode }],
  })
  matrix('a bottom axis', AXIS_PARTS, (_p, e) => axis('bottom', e))
  matrix('a left axis', AXIS_PARTS, (_p, e) => axis('left', e))
  extras('an axis', AXIS_PARTS, (part, b) => axis('bottom', { [part]: b }))
})

describe('legend parts', () => {
  const LEGEND_PARTS = ['legend', 'title', 'labels', 'symbols', 'entries', 'gradient']
  const legend = (spec: Spec, encode: Spec): Spec => frame({ scales: SCALES, legends: [{ title: 'T', ...spec, encode }] })
  matrix('a symbol legend', LEGEND_PARTS, (_p, e) => legend({ fill: 'cat' }, e))
  matrix('a symbol legend in two columns, clipped', LEGEND_PARTS, (_p, e) => legend({ fill: 'cat', columns: 2, clipHeight: 20 }, e))
  matrix('a vertical gradient legend', LEGEND_PARTS, (_p, e) => legend({ fill: 'lin' }, e))
  matrix('a horizontal gradient legend', LEGEND_PARTS, (_p, e) => legend({ fill: 'lin', orient: 'bottom', direction: 'horizontal' }, e))
  matrix('a discrete legend (quantize)', LEGEND_PARTS, (_p, e) => legend({ fill: 'qz' }, e))
  matrix('a discrete legend (threshold), horizontal', LEGEND_PARTS, (_p, e) => legend({ fill: 'th', orient: 'top', direction: 'horizontal' }, e))
  matrix('a size legend', LEGEND_PARTS, (_p, e) => legend({ size: 'size' }, e))
  extras('a symbol legend', LEGEND_PARTS, (part, b) => legend({ fill: 'cat' }, { [part]: b }))
  extras('a gradient legend', LEGEND_PARTS, (part, b) => legend({ fill: 'lin' }, { [part]: b }))
  extras('a discrete legend', LEGEND_PARTS, (part, b) => legend({ fill: 'qz' }, { [part]: b }))
})

describe('title parts', () => {
  const TITLE_PARTS = ['group', 'title', 'subtitle']
  const title = (orient: string, encode: Spec): Spec => frame({ scales: SCALES, title: { text: 'Title', subtitle: 'Sub', orient, encode } })
  matrix('a top title', TITLE_PARTS, (_p, e) => title('top', e))
  matrix('a left title', TITLE_PARTS, (_p, e) => title('left', e))
  extras('a title', TITLE_PARTS, (part, b) => title('top', { [part]: b }))
  it('the deprecated top-level encode block of a title text, and its own name', async () => {
    const spec = frame({ title: { text: 'Title', name: 'legacy', style: 'group-subtitle', encode: { update: { fill: { value: 'tomato' } } } } })
    expect(await differences(spec)).toEqual([])
  })
})

describe('the same on a group mark\'s guides', () => {
  it('an axis, a legend and a title inside a group mark', async () => {
    const encode = { axis: { update: { description: { value: 'AX' } } }, labels: { update: { fill: { value: 'red' }, angle: { value: 30 } } }, title: { enter: { fill: { value: 'blue' } } } }
    const spec = frame({
      marks: [{
        type: 'group', encode: { update: { x: { value: 2 }, y: { value: 2 }, width: { value: 80 }, height: { value: 60 } } },
        scales: SCALES, axes: [{ orient: 'left', scale: 'y', title: 'T', encode }],
        legends: [{ fill: 'cat', title: 'L', encode: { symbols: { update: { size: { value: 400 } } }, entries: { update: { stroke: { value: 'grey' } } } } }],
        title: { text: 'In the group', encode: { title: { update: { fontSize: { value: 18 } } } } },
      }],
    })
    expect(await differences(spec)).toEqual([])
  })
})

describe('the matrix is not vacuous', () => {
  it('a channel moves the part it names, and a part no channel moves would be caught', async () => {
    const plain = frame({ scales: SCALES, axes: [{ orient: 'bottom', scale: 'x', title: 'T' }] })
    const encoded = frame({ scales: SCALES, axes: [{ orient: 'bottom', scale: 'x', title: 'T', encode: { labels: { update: { fill: { value: 'orange' }, angle: { value: 20 } } } } }] })
    expect(await oracleSvg(encoded)).not.toEqual(await oracleSvg(plain))
    expect(renderSpec(encoded as never)).not.toEqual(renderSpec(plain as never))
    expect(Object.keys(CHANNELS).length).toBeGreaterThan(35)
  })
  it('what vega itself refuses is one thing: a list of styles on a title group or subtitle (vega-parser writes `nullnull` into an expression)', () => {
    // (runs last, in file order)
    expect(refused.filter((r) => r !== 'Unrecognized signal name: "nullnull"')).toEqual([])
    expect(refused.length).toBeLessThanOrEqual(4)
  })
})
