// @vitest-environment node
/**
 * The add-on detector names what the engine asks for (C127), whatever the shape the spec takes: an add-on function called from
 * every place the engine evaluates an expression, at the top and inside group marks; an object shared between several places,
 * whatever the order of the keys; a cyclic `events` object (C402). And `loadAddons` refuses a name that is not an add-on by
 * rejecting, before importing anything (C627).
 *
 * This file imports no add-on (vitest gives each file its own module registry): an expression that calls `geoArea` makes the
 * engine ask for the geo add-on, which is the ground truth the detector is held to.
 */
import { describe, expect, it } from 'vitest'
import { renderSpec, type VgSpec } from './index.js'
import { addonsNeeded, isAddonLoaded, loadAddons, loadAddonsFor, partsNeeded, specNeeds } from './addons.js'

const CALL = 'geoArea({type: "Sphere"})'
const MISSING_GEO = /load the addon first: await import\("@aster-charts\/core\/geo"\)/

type Json = Record<string, unknown>
const rect = (enter: Json, extra: Json = {}): Json => ({ type: 'rect', encode: { enter: { x: { value: 0 }, y: { value: 0 }, width: { value: 5 }, height: { value: 5 }, ...enter } }, ...extra })

/** Every place an expression stands in a spec, holding the call. */
const SITES: Record<string, Json> = {
  'signal init': { signals: [{ name: 's', init: CALL }] },
  'signal update': { signals: [{ name: 's', update: CALL }] },
  'signal handler update': { signals: [{ name: 's', value: 0, on: [{ events: 'click', update: CALL }] }] },
  'signal handler {signal} update': { signals: [{ name: 's', value: 0, on: [{ events: 'click', update: { signal: CALL } }] }] },
  'event stream filter': { signals: [{ name: 's', value: 0, on: [{ events: 'click[geoArea(null) > 0]', update: '1' }] }] },
  'event stream object filter': { signals: [{ name: 's', value: 0, on: [{ events: { type: 'click', filter: `${CALL} > 0` }, update: '1' }] }] },
  'encode {signal}': { marks: [rect({ fill: { signal: `${CALL} > 0 ? 'red' : 'blue'` } })] },
  'encode value holding a {signal}': { marks: [rect({ fill: { value: { signal: `${CALL} > 0 ? 'red' : 'blue'` } } })] },
  'encode rule test': { marks: [rect({ fill: [{ test: `${CALL} > 0`, value: 'red' }, { value: 'blue' }] })] },
  'encode offset {signal}': { marks: [rect({ x: { value: 0, offset: { signal: CALL } } })] },
  'encode mult {signal}': { marks: [rect({ width: { value: 5, mult: { signal: CALL } } })] },
  'formula expr': { data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'formula', expr: CALL, as: 'b' }] }] },
  'filter expr': { data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: `${CALL} > 0` }] }] },
  'transform parameter {signal}': { data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'sample', size: { signal: CALL } }] }] },
  'data values {signal}': { data: [{ name: 'd', values: { signal: `[{a: ${CALL}}]` } }] },
  'data trigger insert': { signals: [{ name: 's', value: 0 }], data: [{ name: 'd', values: [], on: [{ trigger: 's', insert: `{a: ${CALL}}` }] }] },
  'data trigger values': { signals: [{ name: 's', value: 0 }], data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', modify: 'datum', values: `{a: ${CALL}}` }] }] },
  'data trigger modify': { signals: [{ name: 's', value: 0 }], data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', modify: CALL, values: '{a: 2}' }] }] },
  'data trigger condition': { data: [{ name: 'd', values: [], on: [{ trigger: CALL, insert: '{a: 1}' }] }] },
  'mark trigger': { signals: [{ name: 's', value: 0 }], marks: [rect({}, { name: 'm', on: [{ trigger: `s && ${CALL}`, modify: 'item()', values: '{}' }] })] },
  'scale domain {signal}': { scales: [{ name: 'x', type: 'linear', domain: { signal: `[0, ${CALL}]` }, range: [0, 1] }], marks: [rect({ x: { scale: 'x', value: 1 } })] },
  'scale range {signal}': { scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: { signal: `[0, ${CALL}]` } }], marks: [rect({ x: { scale: 'x', value: 1 } })] },
  'axis title {signal}': { scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 10] }], axes: [{ scale: 'x', orient: 'bottom', title: { signal: `'' + ${CALL}` } }] },
  'legend values with a {signal}': { scales: [{ name: 'c', type: 'ordinal', domain: ['a'], range: ['red'] }], legends: [{ fill: 'c', values: [{ signal: CALL }] }] },
  'title text {signal}': { title: { text: { signal: `'' + ${CALL}` } } },
  'view property {signal}': { background: { signal: `${CALL} > 0 ? 'white' : 'black'` } },
}

/** The site again, inside a group mark (its signals, data, scales and marks are the group's). */
function inGroup(site: Json): Json {
  const { title, background, ...rest } = site
  void title; void background
  return { marks: [{ type: 'group', ...rest, marks: [...((rest.marks as Json[] | undefined) ?? []), rect({})] }] }
}

describe('addonsNeeded names an add-on wherever the engine asks for it (C127)', () => {
  const cases: Array<[string, VgSpec]> = []
  for (const [name, site] of Object.entries(SITES)) {
    cases.push([name, { width: 20, height: 20, ...site } as VgSpec])
    if (!('title' in site) && !('background' in site)) cases.push([`${name}, in a group mark`, { width: 20, height: 20, ...inGroup(site) } as VgSpec])
  }

  /**
   * The sites that run only when an event fires or a trigger's signal changes (handlers, stream filters, data and mark triggers):
   * a static render does not reach them, an interactive chart does, and needs the add-on then. The compile check parses each of
   * them as an expression (spec-expressions.ts), so the detector must name the add-on for them too.
   */
  const AT_RUN_TIME = /signal handler|event stream|trigger/

  it('the engine asks for geo at every other site, at render (the cases are not vacuous)', () => {
    expect(isAddonLoaded('geo')).toBe(false)
    const unasked = cases.filter(([name, spec]) => {
      if (AT_RUN_TIME.test(name)) return false
      try { renderSpec(spec); return true } catch (e) { return !MISSING_GEO.test(String((e as Error).message)) }
    }).map(([name]) => name)
    // (an encode `value` is the object it holds, a `{signal}` in it too, as vega quotes it into the entry's code: C397; a legend's
    // `values` list is one expression, as vega's objectProperty makes it, so a `{signal}` in it is evaluated: C398)
    expect(unasked).toEqual(['encode value holding a {signal}', 'encode value holding a {signal}, in a group mark'])
  })

  for (const [name, spec] of cases) {
    it(name, () => {
      let asks = AT_RUN_TIME.test(name)
      try { renderSpec(spec) } catch (e) { asks ||= MISSING_GEO.test(String((e as Error).message)) }
      if (asks) expect(addonsNeeded(spec), 'the engine asks for geo').toContain('geo')
    })
  }
})

describe('an object shared between places is read for each place it is in, whatever the order of the keys (C127)', () => {
  /** Every order of a list. */
  const orders = <T>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]))

  it('a transform object that is also in usermeta, config and a signal value; an expression object reused as data', () => {
    const shared = { type: 'pie', field: 'a' }
    const withExpr = { signal: CALL }
    const parts: Record<string, unknown> = {
      data: [{ name: 'd', values: [{ a: 1 }], transform: [shared] }],
      usermeta: { note: shared, again: withExpr },
      config: { custom: shared },
      signals: [{ name: 's', value: shared }],
      marks: [rect({ fill: withExpr })],
    }
    const answers = new Set<string>()
    for (const order of orders(Object.keys(parts))) {
      const spec = Object.fromEntries(order.map((k) => [k, parts[k]])) as VgSpec
      answers.add(JSON.stringify([...addonsNeeded(spec)].sort()))
      answers.add(JSON.stringify([...partsNeeded(spec)].sort()))
    }
    expect([...answers].map((a) => JSON.parse(a) as string[]).filter((a) => a.includes('transforms'))).toHaveLength(1)
    expect(answers.size).toBe(2) // one answer for the add-ons, one for the parts: the same for every order
    const first = JSON.parse([...answers][0]!) as string[]
    expect(first).toEqual(expect.arrayContaining(['geo', 'transforms']))
  })

  it('a cyclic spec is read once per (object, key): no endless walk, the same answer', () => {
    const t: Json = { type: 'pie', field: 'a' }
    t.self = t
    const spec = { data: [{ name: 'd', values: [{ a: 1 }], transform: [t] }], usermeta: { t } } as unknown as VgSpec
    expect(addonsNeeded(spec)).toEqual(['transforms'])
  })
})

describe('a cyclic or deep events object (C402)', () => {
  it('is read without throwing; a timer in it is found', () => {
    const cyc: Json = { type: 'click' }
    cyc.between = [cyc, cyc]
    const timer: Json = { type: 'timer', throttle: 100 }
    timer.self = timer
    const spec = (events: unknown): VgSpec => ({ signals: [{ name: 's', value: 0, on: [{ events, update: '1' }] }] } as unknown as VgSpec)
    expect(() => specNeeds(spec(cyc))).not.toThrow()
    expect(partsNeeded(spec(cyc))).not.toContain('timer')
    expect(partsNeeded(spec(timer))).toContain('timer')
    return expect(loadAddonsFor(spec(cyc))).resolves.toBeUndefined()
  })
})

describe('loadAddons refuses a name that is not an add-on by rejecting, before importing anything (C627)', () => {
  it('unknown names, prototype names, non-strings, a non-array', async () => {
    for (const names of [['nope'], ['toString'], ['constructor'], ['geo', 'nope'], [5], [null]] as unknown[][]) {
      let p: Promise<void> | undefined
      expect(() => { p = loadAddons(names as never) }, JSON.stringify(names)).not.toThrow()
      await expect(p, JSON.stringify(names)).rejects.toThrow(TypeError)
      await expect(p).rejects.toThrow(/not an add-on/)
    }
    await expect(loadAddons('geo' as never)).rejects.toThrow(TypeError)
    // ['geo', 'nope'] imported nothing
    expect(isAddonLoaded('geo')).toBe(false)
  })
})
