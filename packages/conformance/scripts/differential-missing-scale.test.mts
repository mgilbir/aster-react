/**
 * An encode entry that reads a scale the spec never declared, against the pinned real Vega, in this process.
 *
 * Vega compiles an entry to an expression that calls the scale from the encoder's parameters. With no such scale a call
 * (`{scale, field | value | signal}`, a `range`, an `extra`) fails: the dataflow logs the error and stops, the item that failed keeps
 * the channels evaluated before it and nothing after it is encoded or built (see error-semantics.test.ts). A `band` on its own
 * reads a bandwidth of 0 and `{scale}` alone is 0: neither fails. Every mark type, many channels, every entry shape, the scale named
 * statically and by a signal or a field, in conditional encodes and nested in mult/offset/band, mixed with scales that exist.
 *
 * Compared: the picture (strict canonicalizer), whether and how many errors were logged, the error's class, and for a scale named
 * statically its message too (the text is the same TypeError V8 words for vega's compiled call). The guides' entries are held to the
 * same (one error, the same picture): see the last block.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

type Spec = Record<string, unknown>

async function onVega(spec: Spec): Promise<{ svg: string; errors: string[] }> {
  const errors: string[] = []
  const logger = {
    level() { return 2 },
    error: (...a: unknown[]) => { errors.push(String(a[0])); return logger },
    warn: () => logger, info: () => logger, debug: () => logger,
  }
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

const MARKS: Array<[string, Record<string, unknown>]> = [
  ['rect', { width: { value: 6 }, height: { value: 6 }, fill: { value: 'teal' } }],
  ['symbol', { size: { value: 40 }, fill: { value: 'teal' } }],
  ['text', { text: { field: 'a' }, fill: { value: 'teal' } }],
  ['line', { x: { field: 'a', mult: 20 }, y: { value: 10 }, stroke: { value: 'teal' } }],
  ['area', { x: { field: 'a', mult: 20 }, y: { value: 10 }, y2: { value: 30 }, fill: { value: 'teal' } }],
  ['rule', { x: { field: 'a', mult: 20 }, y: { value: 10 }, y2: { value: 30 }, stroke: { value: 'teal' } }],
  ['arc', { outerRadius: { value: 20 }, fill: { value: 'teal' } }],
  ['path', { path: { value: 'M0,0L8,8L0,8Z' }, fill: { value: 'teal' } }],
  ['trail', { x: { field: 'a', mult: 20 }, y: { value: 10 }, size: { value: 4 }, fill: { value: 'teal' } }],
  ['image', { width: { value: 6 }, height: { value: 6 }, url: { value: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }],
  ['group', { width: { value: 30 }, height: { value: 20 }, fill: { value: '#eee' } }],
]
const CHANNELS = ['x', 'y', 'x2', 'y2', 'xc', 'yc', 'width', 'height', 'fill', 'stroke', 'opacity', 'fillOpacity', 'size', 'angle', 'fontSize', 'strokeWidth', 'innerRadius', 'outerRadius', 'startAngle', 'endAngle', 'cornerRadius', 'dx', 'baseline']

const SCALES = ['nope', 'no pe', 'x_', '', 'band_'] // none of them declared (the spec declares `xs` and `bs`)

type Shape = (r: Rng, scale: unknown) => Record<string, unknown> | Array<Record<string, unknown>>

const SHAPES: Array<[string, Shape]> = [
  ['field', (_r, scale) => ({ scale, field: 'a' })],
  ['value', (_r, scale) => ({ scale, value: 3 })],
  ['null value', (_r, scale) => ({ scale, value: null })],
  ['signal', (_r, scale) => ({ scale, signal: 'k + 1' })],
  ['band', (_r, scale) => ({ scale, band: 1 })],
  ['band fraction and offset', (r, scale) => ({ scale, band: r.pick([0.5, 0.25]), offset: r.pick([1, 4]) })],
  ['band signal', (_r, scale) => ({ scale, band: { signal: 'k' } })],
  ['range', (r, scale) => ({ scale, range: r.pick([0, 0.5, 1]) })],
  ['alone', (_r, scale) => ({ scale })],
  ['alone with mult and offset', (_r, scale) => ({ scale, mult: 2, offset: 3 })],
  ['field and band', (_r, scale) => ({ scale, field: 'a', band: 0.5 })],
  ['band and extra', (_r, scale) => ({ scale, band: 1, extra: true })],
  ['field, band and extra', (_r, scale) => ({ scale, field: 'a', band: 1, extra: true })],
  ['field with mult, offset, round', (_r, scale) => ({ scale, field: 'a', mult: 2, offset: 1, round: true })],
  ['exponent', (_r, scale) => ({ scale, exponent: 2 })],
  ['conditional', (_r, scale) => [{ test: 'datum.a > 1', scale, field: 'a' }, { value: 3 }]],
  ['conditional, the other branch', (_r, scale) => [{ test: 'datum.a > 5', scale, field: 'a' }, { value: 3 }]],
  ['nested in mult', (_r, scale) => ({ value: 1, mult: { scale, field: 'a' } })],
  ['nested in offset', (_r, scale) => ({ field: 'a', offset: { scale, band: 1 } })],
  ['nested in band', (_r, scale) => ({ scale: 'xs_ok', band: { scale, field: 'a' } })],
]

const EXISTS: Array<[string, (r: Rng) => Record<string, unknown>]> = [
  ['an existing scale', (r) => ({ scale: 'xs', field: 'a', ...r.pick([{}, { offset: 2 }, { mult: 0.5 }]) })],
  ['an existing band', () => ({ scale: 'bs', band: 1 })],
  ['an existing band with a field', () => ({ scale: 'bs', field: 'nm', band: 0.5 })],
  ['an existing range', () => ({ scale: 'xs', range: 0.5 })],
  ['a constant', () => ({ value: 7 })],
  ['a field', () => ({ field: 'a', mult: 3 })],
]

describe('a scale that does not exist is read as vega reads it', () => {
  it(`${scaled(700)} generated marks`, { timeout: 600_000 }, async () => {
    const r = makeRng(5)
    const bad: string[] = []
    let failed = 0
    let compared = 0
    const types = new Set<string>()
    const shapes = new Set<string>()
    for (let c = 0; c < scaled(700); c++) {
      const [type, base] = r.pick(MARKS)
      const update: Record<string, unknown> = { ...base }
      const picked: string[] = []
      const n = r.between(1, 3)
      for (let j = 0; j < n; j++) {
        const channel = r.pick(CHANNELS)
        if (r.chance(0.25)) {
          const [name, make] = r.pick(EXISTS)
          update[channel] = make(r)
          picked.push(`${channel}: ${name}`)
          continue
        }
        const [name, make] = r.pick(SHAPES)
        // (the scale named by the entry: written out, by a signal holding the name, or by a field holding it)
        const how = r.pick(['static', 'static', 'static', 'signal', 'datum'])
        const scale: unknown = how === 'static' ? r.pick(SCALES) : how === 'signal' ? { signal: 'sname' } : { datum: 'nm' }
        const entry = make(r, scale)
        update[channel] = entry
        picked.push(`${channel}: ${name} (${how})`)
        shapes.add(name)
      }
      types.add(type)
      const spec: Spec = {
        width: 120, height: 60, padding: 4, autosize: 'none',
        signals: [{ name: 'k', value: 2 }, { name: 'sname', value: 'nope' }],
        scales: [
          { name: 'xs', type: 'linear', domain: [0, 4], range: [0, 100] },
          { name: 'xs_ok', type: 'band', domain: [1, 2, 3], range: 'width' },
          { name: 'bs', type: 'band', domain: ['p', 'q', 'nope'], range: 'width' },
        ],
        data: [{ name: 't', values: [{ a: 1, nm: 'nope', extra: { value: 2 } }, { a: 2, nm: 'zz' }, { a: 3, nm: 'nope', extra: { value: 3 } }] }],
        marks: [
          { type, from: { data: 't' }, encode: { update } },
          // (what comes after a failed mark is never built)
          { type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'a', mult: 10 }, y: { value: 50 }, width: { value: 4 }, height: { value: 4 }, fill: { value: 'crimson' } } } },
        ],
      }
      const label = `${type} ${picked.join('; ')}`
      const want = await onVega(spec)
      let got: ReturnType<typeof onAster>
      try {
        got = onAster(spec)
      } catch (e) {
        bad.push(`${label}: aster threw ${(e as Error).message}`)
        continue
      }
      compared++
      if (want.errors.length) failed++
      if (want.errors.length !== got.errors.length) {
        bad.push(`${label}: vega logged ${JSON.stringify(want.errors)}, aster ${JSON.stringify(got.errors)}`)
        continue
      }
      // (a scale named dynamically fails with a message of the compiled expression: the class is what is compared)
      const dynamic = picked.some((p) => /\((signal|datum)\)/.test(p))
      for (let i = 0; i < want.errors.length; i++) {
        const same = dynamic ? want.errors[i]!.split(':')[0] === got.errors[i]!.split(':')[0] : want.errors[i] === got.errors[i]
        if (!same) bad.push(`${label}: vega logged ${JSON.stringify(want.errors[i])}, aster ${JSON.stringify(got.errors[i])}`)
      }
      const d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))
      if (d.length) bad.push(`${label}: ${d.slice(0, 2).join(' | ')}`)
    }
    expect(bad.slice(0, 6)).toEqual([])
    // not vacuous: many cases fail in vega, many do not, and every mark type and entry shape was drawn
    expect(failed).toBeGreaterThan(scaled(700) * 0.3)
    expect(compared - failed).toBeGreaterThan(scaled(700) * 0.1)
    expect(types.size).toBe(MARKS.length)
    expect(shapes.size).toBe(SHAPES.length)
  })
})

describe('a scale outside the scope of the mark is missing for it', () => {
  const child = (scale: string, entry: Record<string, unknown> = { field: 'a' }): Spec => ({
    type: 'rect', from: { data: 't' },
    encode: { update: { x: { scale, ...entry }, y: { value: 2 }, width: { value: 4 }, height: { value: 4 }, fill: { value: 'teal' } } },
  })
  const group = (name: string, scales: unknown[], marks: unknown[]): Spec => ({
    type: 'group', name, encode: { update: { width: { value: 50 }, height: { value: 20 } } }, scales, marks,
  })
  const inner = { name: 'inner', type: 'linear', domain: [0, 4], range: [0, 40] }
  const outer = { name: 'outer', type: 'linear', domain: [0, 4], range: [0, 100] }
  const CASES: Array<[string, Spec[]]> = [
    ['a child reads its own group scale', [group('g1', [inner], [child('inner')])]],
    ['a child reads a scale of the view', [group('g1', [], [child('outer')])]],
    ['a child reads a sibling group scale', [group('g1', [inner], [child('inner')]), group('g2', [], [child('inner')])]],
    // (the view's mark comes first: the contents of a group are made after the marks of its scope, whatever the spec's order)
    ['a mark of the view reads a group scale', [child('inner'), group('g1', [inner], [child('inner')])]],
    ['a group shadows a scale of the view', [group('g1', [{ ...inner, name: 'outer' }], [child('outer')]), child('outer')]],
    ['a mark of the view, a group scale, a group', [child('inner'), group('g1', [inner], [child('inner')]), group('g2', [], [child('inner')])]],
    ['a band read in a sibling group', [group('g1', [{ name: 'bw', type: 'band', domain: ['a', 'b'], range: [0, 40] }], [child('bw', { band: 1 })]), group('g2', [], [child('bw', { band: 1 })])]],
    ['a range read in a sibling group', [group('g1', [inner], [child('inner', { range: 0.5 })]), group('g2', [], [child('inner', { range: 0.5 })])]],
  ]
  it.each(CASES)('%s', async (_name, marks) => {
    const spec: Spec = {
      width: 120, height: 60, padding: 4, autosize: 'none',
      scales: [outer], data: [{ name: 't', values: [{ a: 1 }, { a: 2 }, { a: 3 }] }], marks,
    }
    const want = await onVega(spec)
    const got = onAster(spec)
    expect(got.errors).toEqual(want.errors)
    expect(diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))).toEqual([])
  })
})

// Every path that resolves a scale reference, reached by the entry shape that selects it:
//  - a plain mark entry of exactly {scale, field}: the encoder's plain-key fast path (it hands a missing scale to the general resolver);
//  - any other mark entry: the general resolver;
//  - a guide part's entry of {scale, field, band?, extra?, offset?, round?} with plain names: guide-encode's scaled-field closure;
//  - a guide part's entry of {scale, range, mult?, offset?, round?}: guide-encode's range closure;
//  - any other guide entry: the general resolver again, through the host.
// A guide stops the run the way a mark does: one error, and what the pass had made when it stopped. Held: the errors (how many, and
// their messages) and the picture.
describe('every path that reads a scale reference fails with the message of vega', () => {
  const GUIDE_SHAPES: Array<[string, string, () => Record<string, unknown>]> = [
    ['guide scaled-field closure', 'field', () => ({ scale: 'nope', field: 'value' })],
    ['guide scaled-field closure', 'field, band', () => ({ scale: 'nope', field: 'value', band: 0.5 })],
    ['guide scaled-field closure', 'field, offset, round', () => ({ scale: 'nope', field: 'value', offset: 2, round: true })],
    ['guide scaled-field closure', 'field, band, extra', () => ({ scale: 'nope', field: 'value', band: 1, extra: true })],
    ['guide range closure', 'range', () => ({ scale: 'nope', range: 0.5 })],
    ['guide range closure', 'range, mult, offset', () => ({ scale: 'nope', range: 0.25, mult: 2, offset: 1 })],
    ['guide range closure', 'range, round', () => ({ scale: 'nope', range: 1, round: true })],
    ['general resolver in a guide', 'signal', () => ({ scale: 'nope', signal: 'datum.value' })],
    ['general resolver in a guide', 'value', () => ({ scale: 'nope', value: 3 })],
  ]
  const PARTS: Array<[string, string]> = [['axis', 'labels'], ['axis', 'ticks'], ['axis', 'domain'], ['axis', 'grid'], ['legend', 'labels'], ['legend', 'symbols']]
  const CHANNELS = ['x', 'y', 'dx', 'opacity', 'fontSize']
  it.each(GUIDE_SHAPES)('%s: %s', async (_path, _name, make) => {
    const bad: string[] = []
    const r = makeRng(77)
    for (const [kind, part] of PARTS) {
      for (let k = 0; k < 4; k++) {
        const entry = make()
        const encode = { [part]: { update: { [r.pick(CHANNELS)]: entry } } }
        const spec: Spec = {
          width: 100, height: 50, padding: 5,
          scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] }],
          ...(kind === 'axis' ? { axes: [{ scale: 'x', orient: r.pick(['bottom', 'left']), grid: true, encode }] } : { legends: [{ fill: 'c', encode }] }),
        }
        const want = await onVega(spec)
        const got = onAster(spec)
        // (the part must exist for the entry to run: a vega run that logged nothing proves nothing about the path)
        if (want.errors.length === 0 && got.errors.length === 0) continue
        const picture = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))
        if (JSON.stringify(want.errors) !== JSON.stringify(got.errors)) bad.push(`${kind}.${part} ${JSON.stringify(entry)}: vega ${JSON.stringify(want.errors)}, aster ${JSON.stringify(got.errors.slice(0, 3))} (${got.errors.length})`)
        else if (picture.length) bad.push(`${kind}.${part} ${JSON.stringify(entry)}: ${picture.slice(0, 2).join(' | ')}`)
        else exercised.add(`${_path}: ${_name}`)
      }
    }
    expect(bad).toEqual([])
    expect(exercised.has(`${_path}: ${_name}`), 'the shape reached a failing entry in vega and in Aster').toBe(true)
  })
  const exercised = new Set<string>()

  it('a plain {scale, field} mark entry and a general one both fail with the message, and the plain one is the fast path', async () => {
    for (const entry of [{ scale: 'nope', field: 'a' }, { scale: 'nope', field: 'a', offset: 1 }, { scale: 'nope', field: 'a', band: 1 }]) {
      const spec: Spec = {
        width: 60, height: 30, data: [{ name: 't', values: [{ a: 1 }, { a: 2 }] }],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: entry, width: { value: 3 }, height: { value: 3 } } } }],
      }
      const want = await onVega(spec)
      expect(want.errors).toEqual(['TypeError: _.%nope is not a function'])
      expect(onAster(spec).errors).toEqual(want.errors)
    }
  })
})
