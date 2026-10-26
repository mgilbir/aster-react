// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA, xq, yq, cn, compileFrozen, objects, strings } from './helpers.js'
import { getTimeUnitParts } from '../src/timeunit.js'

const CONFORMANCE = join(__dirname, '..', '..', 'conformance')
const corpus: Array<[string, any]> = []
for (const dir of ['corpus', 'corpus-vega-only']) {
  const d = join(CONFORMANCE, dir)
  if (!existsSync(d)) continue
  for (const f of readdirSync(d).filter((x) => x.endsWith('.vl.json')).sort()) {
    const doc = JSON.parse(readFileSync(join(d, f), 'utf8'))
    corpus.push([f.replace('.vl.json', ''), doc.$schema ? doc : (doc.spec ?? doc)])
  }
}

/** Names defined anywhere in a Vega spec, by kind. */
function defined(vg: any): { data: Set<string>; scales: Set<string>; dupes: string[] } {
  const data = new Set<string>()
  const scales = new Set<string>()
  const dupes: string[] = []
  const add = (set: Set<string>, n: string, what: string) => {
    if (set.has(n)) dupes.push(`${what} ${n}`)
    set.add(n)
  }
  for (const o of objects(vg)) {
    if (Array.isArray(o.data)) for (const d of o.data) if (typeof d?.name === 'string') add(data, d.name, 'dataset')
    if (Array.isArray(o.scales)) for (const s of o.scales) if (typeof s?.name === 'string') add(scales, s.name, 'scale')
    if (o.facet && typeof o.facet.name === 'string') add(data, o.facet.name, 'facet')
    if (o.type && typeof o.name === 'string' && o !== vg && Array.isArray(vg.marks)) data.add(o.name)
  }
  return { data, scales, dupes }
}

describe('every compiled corpus spec is internally consistent (C71)', () => {
  for (const [name, spec] of corpus) {
    it(`${name}: all scale/dataset references resolve, no duplicates, no invalid values`, () => {
      const vg = compileFrozen(spec)
      const { data, scales, dupes } = defined(vg)
      expect(dupes, 'duplicate names').toEqual([])
      const sigNames = new Set<string>()
      for (const o of objects(vg)) {
        if (Array.isArray(o.signals)) for (const s of o.signals) sigNames.add(s.name)
      }
      for (const o of objects(vg)) {
        // scale references
        for (const k of ['scale', 'gridScale'] as const) {
          if (typeof o[k] === 'string') expect(scales.has(o[k]), `${k} "${o[k]}" is not a defined scale`).toBe(true)
        }
        // legend scale properties
        if (o.title !== undefined || o.encode !== undefined) {
          for (const k of ['fill', 'stroke', 'size', 'shape', 'opacity', 'strokeWidth'] as const) {
            if (typeof o[k] === 'string' && ('symbolType' in o || 'gradientLength' in o)) {
              expect(scales.has(o[k]), `legend ${k} "${o[k]}" is not a defined scale`).toBe(true)
            }
          }
        }
        // dataset references
        if (typeof o.from?.data === 'string') expect(data.has(o.from.data), `from.data "${o.from.data}" is undefined`).toBe(true)
        if (typeof o.data === 'string' && o.field !== undefined) expect(data.has(o.data), `domain data "${o.data}" is undefined`).toBe(true)
        // (an event stream {source: 'view', type: 'click'} also has a `source`; a dataset never has a `type`)
        if (typeof o.source === 'string' && o.type === undefined) expect(data.has(o.source), `dataset source "${o.source}" is undefined`).toBe(true)
        // values real vega rejects (C71)
        if (o.shape && typeof o.shape === 'object' && 'value' in o.shape) expect(o.shape.value).not.toBe('point')
        if (o.type === 'stack') expect(['zero', 'center', 'normalize']).toContain(o.offset)
        if (o.type === 'bin' && typeof o.signal === 'string') expect(o.signal).toMatch(/^[A-Za-z_]\w*$/)
        if (o.type === 'timeunit') for (const u of o.units ?? []) expect(['year', 'quarter', 'month', 'week', 'date', 'dayofyear', 'day', 'hours', 'minutes', 'seconds', 'milliseconds']).toContain(u)
      }
    })
  }
})

describe('C71 audit repros', () => {
  it('a point mark emits no shape:"point" (real vega rejects it); circle/square name their own', () => {
    const shapes = (mark: string) => {
      const out = compileFrozen({ data: DATA, mark, encoding: { x: xq, y: yq } })
      return out.marks[0].encode.update.shape
    }
    expect(shapes('point')).toBeUndefined()
    expect(shapes('circle')).toEqual({ value: 'circle' })
    expect(shapes('square')).toEqual({ value: 'square' })
  })

  it('stack:true is the string offset "zero", not the invalid boolean', () => {
    const out = compileFrozen({ data: DATA, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative', stack: true }, y: cn } })
    const st = out.data.flatMap((d: any) => d.transform ?? []).find((t: any) => t.type === 'stack')
    expect(st.offset).toBe('zero')
  })

  it('a field with a space gets valid bin signal names', () => {
    const out = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: { field: 'IMDB Rating', type: 'quantitative', bin: true }, y: { aggregate: 'count', type: 'quantitative' } } })
    const bin = out.data.flatMap((d: any) => d.transform ?? []).find((t: any) => t.type === 'bin')
    expect(bin.signal).toMatch(/^[A-Za-z_]\w*$/)
    expect(JSON.stringify(out.scales)).toContain(bin.signal)
  })

  it('concat legends reference scales that exist, shared across children', () => {
    const child = (mark: string) => ({ mark, encoding: { x: xq, y: yq, color: cn } })
    const out = compileFrozen({ data: DATA, hconcat: [child('point'), child('line')] })
    const names = new Set(out.scales.map((s: any) => s.name))
    expect(out.legends.length).toBeGreaterThan(0)
    for (const lg of out.legends) expect(names.has(lg.stroke ?? lg.fill)).toBe(true)
    // one shared colour scale, positional ones private to a child
    expect(out.scales.filter((s: any) => s.name === 'color')).toHaveLength(1)
    expect(out.scales.filter((s: any) => s.name === 'x')).toHaveLength(0)
  })
})

describe('C74: time units and bin options', () => {
  const units = (timeUnit: unknown) => {
    const out = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: { field: 't', type: 'ordinal', timeUnit }, y: { aggregate: 'count', type: 'quantitative' } } })
    return out.data.flatMap((d: any) => d.transform ?? []).find((t: any) => t.type === 'timeunit')
  }
  it('uses the real part list: monthdate is [month, date], not [year, month, date]', () => {
    expect(units('monthdate').units).toEqual(['month', 'date'])
    expect(units('yearmonthdate').units).toEqual(['year', 'month', 'date'])
    expect(units('quartermonth').units).toEqual(['quarter', 'month'])
    expect(units('yeardayofyear').units).toEqual(['year', 'dayofyear'])
    expect(getTimeUnitParts('dayofyear')).toEqual(['dayofyear'])
    expect(getTimeUnitParts('hoursminutesseconds')).toEqual(['hours', 'minutes', 'seconds'])
  })
  it('utc units use a utc timezone; the unit list stays valid', () => {
    const t = units('utcyearmonth')
    expect(t.units).toEqual(['year', 'month'])
    expect(t.timezone).toBe('utc')
    expect(units({ unit: 'month', utc: true }).timezone).toBe('utc')
  })
  it('step is forwarded', () => {
    expect(units({ unit: 'month', step: 3 }).step).toBe(3)
  })
  const bin = (b: unknown) => {
    const out = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: { field: 'v', type: 'quantitative', bin: b }, y: { aggregate: 'count', type: 'quantitative' } } })
    const ts = out.data.flatMap((d: any) => d.transform ?? [])
    return { bin: ts.find((t: any) => t.type === 'bin'), extent: ts.find((t: any) => t.type === 'extent') }
  }
  it('forwards step / extent / nice / base / anchor / minstep / steps / divide / maxbins', () => {
    const b = bin({ step: 2, nice: false, base: 5, anchor: 1, minstep: 1, steps: [1, 2], divide: [5, 2], extent: [0, 10] }).bin
    expect(b).toMatchObject({ step: 2, nice: false, base: 5, anchor: 1, minstep: 1, steps: [1, 2], divide: [5, 2], extent: [0, 10] })
    expect(b.maxbins).toBeUndefined()
  })
  it('an explicit extent replaces the data extent; otherwise the extent is computed', () => {
    expect(bin({ extent: [0, 12], maxbins: 6 }).extent).toBeUndefined()
    const auto = bin(true)
    expect(auto.extent).toBeDefined()
    expect(auto.bin.extent).toEqual({ signal: auto.extent.signal })
    expect(auto.bin.maxbins).toBe(10)
  })
  it('different bin options produce different generated field names', () => {
    const names = [true, { maxbins: 20 }, { step: 5 }, { maxbins: 10, nice: false }].map((b) => bin(b).bin.as[0])
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('C97: argmax / argmin', () => {
  it('compile an argmax encoding (the audit repro crashed with op.charAt)', () => {
    const out = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: cn, y: { field: 'v', type: 'quantitative', aggregate: { argmax: 'x' } } } })
    const ts = out.data.flatMap((d: any) => d.transform ?? [])
    const agg = ts.find((t: any) => t.type === 'aggregate')
    expect(agg.ops).toContain('argmax')
    expect(out.axes.some((a: any) => a.title === 'v for max x')).toBe(true)
  })
})

describe('sorts and domains (C35)', () => {
  const barSort = (sort: unknown) => compileFrozen({ data: DATA, mark: 'bar', encoding: { x: { ...cn, sort }, y: { ...yq, aggregate: 'sum' } } })
  const domainOf = (out: any) => out.scales.find((s: any) => s.name === 'x').domain
  it('-y sorts by the sum of y, descending (not by x)', () => {
    expect(domainOf(barSort('-y')).sort).toEqual({ op: 'sum', field: 'y', order: 'descending' })
  })
  it('{field, op} keeps its op and the default op is min', () => {
    expect(domainOf(barSort({ field: 'v', op: 'max' })).sort).toEqual({ op: 'max', field: 'v' })
    expect(domainOf(barSort({ field: 'v' })).sort).toEqual({ op: 'min', field: 'v' })
  })
  it('an array sorts by a computed index column; unlisted values sort last', () => {
    const out = barSort(['B', 'A'])
    const dom = domainOf(out)
    expect(dom.sort.op).toBe('min')
    const calc = out.data.flatMap((d: any) => d.transform ?? []).find((t: any) => t.as === dom.sort.field)
    expect(calc.expr).toBe('datum["c"]==="B" ? 0 : datum["c"]==="A" ? 1 : 2')
  })
  it('null leaves data order; ascending is sort:true', () => {
    expect(domainOf(barSort(null)).sort).toBeUndefined()
    expect(domainOf(barSort('ascending')).sort).toBe(true)
  })
  it('explicit nominal domains and ranges are honoured on position and colour', () => {
    const out = compileFrozen({ data: DATA, mark: 'point', encoding: { x: { ...cn, scale: { domain: ['B', 'A'] } }, y: yq, color: { field: 'g', type: 'nominal', scale: { domain: ['q', 'p'], range: ['red', 'blue'] } } } })
    expect(out.scales.find((s: any) => s.name === 'x').domain).toEqual(['B', 'A'])
    const color = out.scales.find((s: any) => s.name === 'color')
    expect(color.domain).toEqual(['q', 'p'])
    expect(color.range).toEqual(['red', 'blue'])
  })
})

describe('conditions (C35)', () => {
  it('a test condition wraps the base as [{test, value}, {value}]', () => {
    const out = compileFrozen({ data: DATA, mark: 'point', encoding: { x: xq, y: yq, color: { condition: { test: { field: 'y', gt: 2 }, value: 'red' }, value: 'grey' } } })
    expect(out.marks[0].encode.update.stroke).toEqual([{ test: 'datum["y"]>2', value: 'red' }, { value: 'grey' }])
  })
  it('colour constants map to stroke on point/line/rule and fill elsewhere', () => {
    const upd = (mark: string) => compileFrozen({ data: DATA, mark, encoding: { x: xq, y: yq, color: { value: 'teal' } } }).marks[0].encode.update
    expect(upd('point').stroke).toEqual({ value: 'teal' })
    expect(upd('rule').stroke).toEqual({ value: 'teal' })
    expect(upd('bar').fill).toEqual({ value: 'teal' })
  })
})

describe('missing position channels get explicit defaults (real vega leaves them at 0)', () => {
  it('a point with only x is centred vertically; a rule with only x spans the group', () => {
    const p = compileFrozen({ data: DATA, mark: 'point', encoding: { x: xq } }).marks[0].encode.update
    expect(p.y).toEqual({ signal: 'height', mult: 0.5 })
    const r = compileFrozen({ data: DATA, mark: 'rule', encoding: { x: xq } }).marks[0].encode.update
    expect(r.y).toEqual({ value: 0 })
    expect(r.y2).toEqual({ field: { group: 'height' } })
  })
})

describe('layer composition (C34)', () => {
  it('a parent filter and a parent config reach the layers, nested layers flatten, per-layer data stays separate', () => {
    const out = compileFrozen({
      data: DATA,
      transform: [{ filter: 'datum.x > 1' }],
      config: { mark: { color: 'firebrick' } },
      layer: [{ layer: [{ mark: 'point', encoding: { x: xq, y: yq } }] }, { data: { name: 'other', values: [{ x: 1, y: 1 }] }, mark: 'line', encoding: { x: xq, y: yq } }],
    })
    const filters = out.data.flatMap((d: any) => d.transform ?? []).filter((t: any) => t.type === 'filter' && t.expr === 'datum.x > 1')
    expect(filters).toHaveLength(1) // applied to the first layer's data only, not to its own-data sibling
    expect(out.data.map((d: any) => d.name)).toContain('other')
    // config.mark.color is a MARK default: it must reach the layers' encodes (a layer used to ignore config)
    expect(out.marks[0].encode.update.stroke).toEqual({ value: 'firebrick' })
    expect(out.marks).toHaveLength(2)
  })
})

describe('strings in the output never carry raw spec text outside JSON literals', () => {
  it('smoke: every expression of every corpus spec has balanced quotes and brackets', () => {
    for (const [name, spec] of corpus) {
      const vg = compileFrozen(spec)
      for (const [k, v] of strings(vg)) {
        if (k !== 'expr' && k !== 'signal') continue
        let depth = 0
        let quote = ''
        for (let i = 0; i < v.length; i++) {
          const c = v[i]!
          if (quote) {
            if (c === '\\') i++
            else if (c === quote) quote = ''
          } else if (c === '"' || c === "'") quote = c
          else if (c === '(' || c === '[' || c === '{') depth++
          else if (c === ')' || c === ']' || c === '}') depth--
        }
        expect(quote === '' && depth === 0, `${name}: unbalanced expression ${v}`).toBe(true)
      }
    }
  })
})
