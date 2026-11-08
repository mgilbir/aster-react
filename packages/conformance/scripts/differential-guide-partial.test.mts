/**
 * A guide whose encode throws, against the pinned real Vega, in this process, exhaustively over where it throws.
 *
 * Vega's dataflow stops at the encode that throws: the item keeps the channels evaluated before the failing one, in the order the
 * encode writes them (the `enter` block, then the `update` block over it), the items after it are left unencoded, the marks of the
 * guide that come after it are never made, and the error is logged once. So the picture of a guide that fails depends on the ORDER
 * of the channels of every mark of every guide, on every orient, which nothing else observes.
 *
 * Every part of an axis (grid, ticks, labels, domain, title, the group) on every side, and of a legend of each kind (symbols,
 * a gradient, discrete bands: the group, the entries, the symbols, the labels, the gradient, the title), gets an entry that throws
 * in each channel the guides write, in each block. Compared: the picture (strict canonicalizer), how many errors were logged, and
 * their class.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

type Spec = Record<string, unknown>

async function onVega(spec: Spec): Promise<{ svg: string; errors: string[] }> {
  const errors: string[] = []
  const logger = { level() { return 2 }, error: (...a: unknown[]) => { errors.push(String(a[0])); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View
  const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), errors }
  } finally {
    view.finalize()
  }
}

function onAster(spec: Spec): { svg: string; errors: string[] } {
  const errors: string[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {} }
  return { svg: renderSpec(structuredClone(spec) as never, { logger } as never), errors }
}

/** Every channel the guides' marks write, and some they do not (a channel the encode does not have is added after the others). */
const CHANNELS = [
  'opacity', 'x', 'y', 'x2', 'y2', 'text', 'align', 'baseline', 'angle', 'fill', 'fillOpacity', 'stroke', 'strokeWidth', 'strokeOpacity',
  'strokeDash', 'strokeCap', 'strokeDashOffset', 'font', 'fontSize', 'fontStyle', 'fontWeight', 'limit', 'lineHeight', 'dx', 'dy',
  'anchor', 'auto', 'size', 'shape', 'width', 'height', 'cornerRadius', 'orient', 'offset', 'padding', 'titlePadding', 'translate',
]
const BLOCKS = ['enter', 'update'] as const
const throws = { scale: 'nope', value: 1 }

const FRAME = {
  width: 90, height: 50, padding: 4, autosize: 'none',
  scales: [
    { name: 'x', type: 'linear', domain: [0, 4], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 4], range: 'height' },
    { name: 'c', type: 'ordinal', domain: ['p', 'q'], range: ['red', 'blue'] },
    { name: 'g', type: 'linear', domain: [0, 4], range: ['white', 'black'] },
    { name: 'q', type: 'quantize', domain: [0, 4], range: ['#eee', '#9bd', '#06c'] },
  ],
}

interface Case { label: string; spec: Spec }
const cases: Case[] = []
for (const orient of ['bottom', 'top', 'left', 'right']) {
  for (const part of ['axis', 'grid', 'ticks', 'labels', 'domain', 'title']) {
    for (const channel of CHANNELS) {
      for (const block of BLOCKS) {
        cases.push({
          label: `axis ${orient} ${part} ${block}.${channel}`,
          spec: { ...FRAME, axes: [{ scale: orient === 'left' || orient === 'right' ? 'y' : 'x', orient, grid: true, title: 'T', encode: { [part]: { [block]: { [channel]: throws } } } }] },
        })
      }
    }
  }
}
const LEGENDS: Array<[string, Record<string, unknown>, string[]]> = [
  ['symbol', { fill: 'c', title: 'T' }, ['legend', 'entries', 'symbols', 'labels', 'title']],
  ['gradient', { fill: 'g', title: 'T' }, ['legend', 'gradient', 'labels', 'title']],
  ['discrete', { fill: 'q', title: 'T' }, ['legend', 'gradient', 'labels', 'title']],
]
for (const [kind, legend, parts] of LEGENDS) {
  for (const part of parts) {
    for (const channel of CHANNELS) {
      for (const block of BLOCKS) {
        cases.push({ label: `${kind} legend ${part} ${block}.${channel}`, spec: { ...FRAME, legends: [{ ...legend, encode: { [part]: { [block]: { [channel]: throws } } } }] } })
      }
    }
  }
}
for (const part of ['group', 'title', 'subtitle']) {
  for (const channel of CHANNELS) {
    for (const block of BLOCKS) {
      cases.push({ label: `title ${part} ${block}.${channel}`, spec: { ...FRAME, title: { text: 'T', subtitle: 'S', encode: { [part]: { [block]: { [channel]: throws } } } } } })
    }
  }
}

describe('a guide whose encode throws keeps what the encode wrote before it, as vega does', () => {
  it(`${cases.length} cases: every part of every guide, every channel, both blocks`, { timeout: 900_000 }, async () => {
    const bad: string[] = []
    let failed = 0
    const byPart = new Map<string, number>()
    for (const { label, spec } of cases) {
      const want = await onVega(spec)
      const got = onAster(spec)
      if (want.errors.length) {
        failed++
        const part = label.split(' ').slice(0, 3).join(' ')
        byPart.set(part, (byPart.get(part) ?? 0) + 1)
      }
      if (want.errors.length !== got.errors.length || want.errors[0] !== got.errors[0]) {
        bad.push(`${label}: vega logged ${JSON.stringify(want.errors)}, aster ${JSON.stringify(got.errors.slice(0, 2))}`)
        continue
      }
      const d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))
      if (d.length) bad.push(`${label}: ${d.slice(0, 2).join(' | ')}`)
    }
    if (process.env.GUIDE_PARTIAL_REPORT) console.log([...byPart].map(([k, n]) => `${k}: ${n}`).join('\n'))
    expect(bad.length, `${bad.length} of ${cases.length} cases differ:\n${bad.slice(0, 12).join('\n')}`).toBe(0)
    // not vacuous: the entries failed in vega for the channels the guides write (the others are ignored by their marks), in every part
    expect(failed).toBeGreaterThan(cases.length * 0.9)
    for (const part of ['axis bottom axis', 'axis left grid', 'axis top ticks', 'axis right labels', 'axis bottom domain', 'axis left title', 'symbol legend legend', 'symbol legend entries', 'symbol legend symbols', 'symbol legend labels', 'gradient legend gradient', 'discrete legend gradient', 'title title update.opacity']) {
      expect(byPart.has(part) || [...byPart.keys()].some((k) => k.startsWith(part)), part).toBe(true)
    }
  })
})
