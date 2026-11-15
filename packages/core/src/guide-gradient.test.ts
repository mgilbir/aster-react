/**
 * A guide that paints with a gradient brings its definition to the scene's defs in every evaluation, including those that keep
 * what the evaluation before made: a view's axis kept whole (`keptGuide`), a group mark kept whole with its guides
 * (`keptGroupMark`). A pointer move writes a signal no guide reads, over and over; after every move the scene's SVG and its
 * definitions equal a fresh evaluation's, for every guide kind and every way a guide paints with a gradient: a literal in a part's
 * encode, the guide's own group item, a gradient legend over a scale. The canvas renderer paints each such part with a canvas
 * gradient, never with the reference text the SVG writes.
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToSvg } from './render.js'
import { renderSceneToCanvas } from './canvas.js'
import { makeRecorder } from './canvas-record.testlib.js'
import { createChartSession } from './session.js'
import type { VgSpec } from './types.js'

const lin = { gradient: 'linear', stops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'darkred' }] }
const rad = { gradient: 'radial', stops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'purple' }] }

const SCALES = [
  { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
  { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] },
  { name: 'q', type: 'linear', domain: [0, 10], range: ['white', 'navy'] },
]
const GUIDES: Array<[string, Record<string, unknown>]> = [
  ['an axis part', { axes: [{ orient: 'bottom', scale: 'x', encode: { domain: { update: { stroke: { value: lin } } } } }] }],
  ['the axis group item', { axes: [{ orient: 'bottom', scale: 'x', encode: { axis: { update: { fill: { value: rad }, width: { value: 40 }, height: { value: 20 } } } } }] }],
  ['a symbol legend part', { legends: [{ fill: 'c', encode: { symbols: { update: { stroke: { value: lin }, strokeWidth: { value: 2 } } } } }] }],
  ['a gradient legend over a scale', { legends: [{ fill: 'q', type: 'gradient' }] }],
  ['a title part', { title: { text: 'T', encode: { title: { update: { fill: { value: rad } } } } } }],
]

function spec(guides: Record<string, unknown>, where: 'view' | 'group mark'): VgSpec {
  // (a mark that reads the pointer: the only thing a move changes)
  const pointer = { type: 'rule', encode: { update: { x: { signal: 'hoverX' }, y: { value: 0 }, y2: { value: 80 }, stroke: { value: '#000' } } } }
  const group = { type: 'group', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 100 }, height: { value: 60 } } }, ...guides }
  return {
    width: 140, height: 90, padding: 5, autosize: 'none',
    signals: [{ name: 'hoverX', value: 0 }],
    scales: SCALES,
    ...(where === 'view' ? guides : {}),
    marks: where === 'view' ? [pointer] : [group, pointer],
  } as unknown as VgSpec
}

describe('a guide that paints with a gradient keeps its definition across evaluations', () => {
  for (const where of ['view', 'group mark'] as const) {
    for (const [name, guides] of GUIDES) {
      it(`${where}: ${name}`, () => {
        const s = spec(guides, where)
        const session = createChartSession()
        for (let i = 0; i < 4; i++) {
          const input = { signals: { hoverX: i * 9 } }
          const scene = session.evaluate(s, input)
          const fresh = evaluateChart(compileChart(s), input)
          expect(fresh.defs?.length ?? 0).toBeGreaterThan(0)
          expect(JSON.stringify(scene.defs ?? [])).toBe(JSON.stringify(fresh.defs ?? []))
          expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(fresh))
        }
      })
    }
  }
})

describe('the canvas renderer paints a guide\'s gradient as a gradient', () => {
  for (const where of ['view', 'group mark'] as const) {
    for (const [name, guides] of GUIDES) {
      it(`${where}: ${name}`, () => {
        const { ctx, records } = makeRecorder()
        renderSceneToCanvas(evaluateChart(compileChart(spec(guides, where))), ctx)
        expect(records.filter((r) => r.style.startsWith('grad(')).length).toBeGreaterThan(0)
        expect(records.filter((r) => r.style.includes('url(')).map((r) => r.style)).toEqual([])
      })
    }
  }
})
