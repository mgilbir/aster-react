import { describe, it, expect } from 'vitest'
import { createChartStream } from './stream.js'
import { AsterLimitError } from './limits.js'
import type { VgSpec } from './types.js'

const spec = {
  width: 200, height: 100, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ x: 1, y: 2 }, { x: 5, y: 3 }] }],
  scales: [
    { name: 'sx', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width', zero: false },
    { name: 'sy', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height', zero: false },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'sx', field: 'x' }, y: { scale: 'sy', field: 'y' } } } }],
} as unknown as VgSpec

const domainOf = (scene: unknown, name: string): unknown[] =>
  ((scene as { __scaleMap: Map<string, { domain(): unknown[] }> }).__scaleMap.get(name)!).domain()

describe('stream batch overrides', () => {
  it('a null domainRaw value clears that scale override', () => {
    const stream = createChartStream(spec)
    stream.flush()
    const base = domainOf(stream.scene(), 'sx')
    stream.push({ domainRaw: { sx: [2, 3] } })
    stream.flush()
    expect(domainOf(stream.scene(), 'sx')).toEqual([2, 3])
    stream.push({ domainRaw: { sx: null } })
    stream.flush()
    expect(domainOf(stream.scene(), 'sx')).toEqual(base)
  })

  it('coalesced set+clear ends cleared', () => {
    const stream = createChartStream(spec)
    stream.flush()
    const base = domainOf(stream.scene(), 'sx')
    stream.push({ domainRaw: { sx: [2, 3] } })
    stream.push({ domainRaw: { sx: null } })
    stream.flush()
    expect(domainOf(stream.scene(), 'sx')).toEqual(base)
  })

  it('applies batch limits to later flushes, even over a cached scene', () => {
    const stream = createChartStream(spec)
    stream.flush()
    stream.push({ limits: { maxItems: 1 } })
    expect(() => stream.flush()).toThrow(AsterLimitError)
  })

  it('honours initial.limits and batch textMetrics', () => {
    expect(() => createChartStream(spec, { initial: { limits: { maxItems: 1 } } }).flush()).toThrow(AsterLimitError)
    const calls: string[] = []
    const stream = createChartStream({
      ...(spec as object),
      title: { text: 'hello' },
    } as unknown as VgSpec)
    stream.push({ textMetrics: { measure: (t) => { calls.push(t); return t.length } } })
    stream.flush()
    expect(calls).toContain('hello')
  })
})
