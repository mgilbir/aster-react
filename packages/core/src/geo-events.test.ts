import { describe, expect, it } from 'vitest'
import { Events, LINE_END, LINE_START, POINT, POLYGON_END, POLYGON_START, SPHERE, eventsOf, interleave } from './geo-events.js'

const ops = (ev: Events): number[] => Array.from({ length: ev.length }, (_, i) => ev.op[i]!)

describe('eventsOf', () => {
  it('flattens each geometry into its events', () => {
    expect(ops(eventsOf({ type: 'Point', coordinates: [1, 2] }))).toEqual([POINT])
    expect(ops(eventsOf({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }))).toEqual([POINT, POINT])
    expect(ops(eventsOf({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }))).toEqual([LINE_START, POINT, POINT, POINT, LINE_END])
    expect(ops(eventsOf({ type: 'Sphere' }))).toEqual([SPHERE])
  })

  it('leaves out the repeated closing position of a polygon ring', () => {
    const ev = eventsOf({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })
    expect(ops(ev)).toEqual([POLYGON_START, LINE_START, POINT, POINT, POINT, LINE_END, POLYGON_END])
    expect([ev.x[2]!, ev.y[2]!]).toEqual([0, 0])
    expect(ev.onlyPoints).toBe(false)
  })

  it('reads the geometry of a Feature, and of each feature of a FeatureCollection (geometry-less ones add nothing)', () => {
    const point = { type: 'Point', coordinates: [5, 6] }
    expect(ops(eventsOf({ type: 'Feature', geometry: point }))).toEqual([POINT])
    expect(ops(eventsOf({ type: 'FeatureCollection', features: [{ geometry: point }, { geometry: null }, { geometry: point }] }))).toEqual([POINT, POINT])
    expect(eventsOf({ type: 'Feature', geometry: point }).onlyPoints).toBe(true)
  })

  it('numbers the events by their position, and coerces coordinates to numbers', () => {
    const ev = eventsOf({ type: 'MultiPoint', coordinates: [['1', null], [undefined, 4]] })
    expect([0, 1].map((i) => ev.src[i]!)).toEqual([0, 1])
    expect([ev.x[0]!, ev.y[0]!]).toEqual([1, 0])
    expect(Number.isNaN(ev.x[1]!)).toBe(true)
  })

  it('takes a type name for a handler only when it is one of its own', () => {
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(eventsOf({ type }).length).toBe(0)
      expect(eventsOf({ type: 'Feature', geometry: { type } }).length).toBe(0)
    }
  })

  it('throws the TypeError of a missing coordinates array where it is read', () => {
    expect(() => eventsOf({ type: 'Point' })).toThrow("Cannot read properties of undefined (reading '0')")
    expect(() => eventsOf({ type: 'MultiPoint' })).toThrow("Cannot read properties of undefined (reading 'length')")
  })
})

describe('interleave', () => {
  const buf = (...srcs: number[]): Events => {
    const ev = new Events()
    for (const s of srcs) ev.point(s, 0, s)
    return ev
  }

  it('orders by the input event, then by pipeline', () => {
    const merged = interleave([buf(0, 2, 2), buf(1, 2), buf(0, 3)])
    expect(Array.from({ length: merged.length }, (_, i) => merged.x[i]!)).toEqual([0, 0, 1, 2, 2, 2, 3])
  })

  it('keeps the order of events of one pipeline that share an input event', () => {
    const a = new Events()
    a.point(10, 0, 4)
    a.point(11, 0, 4)
    const b = new Events()
    b.point(20, 0, 4)
    const merged = interleave([a, b])
    expect(Array.from({ length: merged.length }, (_, i) => merged.x[i]!)).toEqual([10, 11, 20])
  })
})
