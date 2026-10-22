// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DATA, cn, compileFrozen } from './helpers.js'

const facetCol = (header: unknown, config?: unknown) => ({
  data: DATA,
  mark: 'bar',
  encoding: {
    x: cn,
    y: { field: 'v', type: 'quantitative' },
    column: { field: 'g', type: 'nominal', ...(header ? { header } : {}) },
  },
  ...(config ? { config } : {}),
})
const marksOf = (vg: any, name: string) => vg.marks.find((m: any) => m.name === name)

describe('facet headers follow vega-lite (header/assemble.ts)', () => {
  it('labelAnchor becomes the title anchor and a derived align, never an invalid title key', () => {
    const vg = compileFrozen(facetCol({ labelAnchor: 'start' }))
    const t = marksOf(vg, 'column_header').title
    expect(t.anchor).toBe('start')
    expect(t.align).toBe('left')
    expect(t.labelAnchor).toBeUndefined()
  })

  it('labelOrient bottom moves the labels into the footer group, beside the axes', () => {
    const vg = compileFrozen(facetCol({ labelOrient: 'bottom' }))
    expect(marksOf(vg, 'column_header')).toBeUndefined()
    const footer = marksOf(vg, 'column_footer')
    expect(footer.title.style).toBe('guide-label')
    expect(footer.axes.length).toBeGreaterThan(0)
  })

  it('an orthogonal labelOrient puts the labels on the cell title', () => {
    const vg = compileFrozen(facetCol({ labelOrient: 'left' }))
    expect(marksOf(vg, 'cell').title.orient).toBe('left')
  })

  it('header.orient is a shortcut for labelOrient and titleOrient, config.header.orient is not', () => {
    const own = compileFrozen(facetCol({ orient: 'bottom' }))
    expect(marksOf(own, 'column-title').title.orient).toBe('bottom')
    expect(own.layout.titleAnchor).toEqual({ column: 'end' })
    const cfg = compileFrozen(facetCol(undefined, { header: { orient: 'bottom' } }))
    expect(marksOf(cfg, 'column-title').title.orient).toBeUndefined()
  })

  it('titleAnchor feeds the layout title band; headerColumn config beats config.header', () => {
    const vg = compileFrozen(facetCol({ titleAnchor: 'end' }, { headerColumn: { titleColor: 'red' }, header: { titleColor: 'blue' } }))
    expect(vg.layout.titleBand).toEqual({ column: 1 })
    expect(marksOf(vg, 'column-title').title.color).toBe('red')
  })

  it('labelExpr rewrites datum.label and datum.value', () => {
    const vg = compileFrozen(facetCol({ labelExpr: "'<' + datum.label + '>' + datum.value" }))
    const sig = marksOf(vg, 'column_header').title.text.signal as string
    expect(sig).toContain('parent["g"]')
    expect(sig).not.toContain('datum.label')
  })

  it('labels:false drops the label title and the header group with it', () => {
    const vg = compileFrozen(facetCol({ labels: false }))
    expect(marksOf(vg, 'column_header')).toBeUndefined()
  })
})

describe('sibling fixes found by the schema sweep', () => {
  it('config.legend.disable removes legends unless the channel gives its own legend object', () => {
    const base = { data: DATA, mark: 'bar', encoding: { x: cn, y: { field: 'v', type: 'quantitative' }, color: cn }, config: { legend: { disable: true } } }
    expect(compileFrozen(base).legends).toBeUndefined()
    const own = { ...base, encoding: { ...base.encoding, color: { ...cn, legend: {} } } }
    expect(compileFrozen(own).legends).toHaveLength(1)
  })

  it('a numeric text field is formatted to a string (so config.text.lineBreak cannot split a number)', () => {
    const vg = compileFrozen({ data: DATA, mark: 'text', encoding: { x: cn, y: { field: 'v', type: 'quantitative' }, text: { field: 'v', type: 'quantitative' } } })
    expect(vg.marks[0].encode.update.text.signal).toBe('format(datum["v"], "")')
  })

  it('an arc with a time-unit colour computes the unit before it stacks and filters', () => {
    const vg = compileFrozen({ data: DATA, mark: 'arc', encoding: { theta: { field: 'v', type: 'quantitative' }, color: { field: 't', type: 'temporal', timeUnit: 'month' } } })
    const tr = vg.data.find((d: any) => d.name === 'data_0').transform as any[]
    const idx = (type: string) => tr.findIndex((t) => t.type === type)
    expect(idx('timeunit')).toBeLessThan(idx('stack'))
    expect(idx('stack')).toBeLessThan(idx('filter'))
    expect(tr[idx('stack')].sort.field).toEqual(['month_t'])
    expect(tr[idx('filter')].expr).toContain('month_t')
    expect(vg.scales.find((s: any) => s.name === 'color').type).toBe('time')
  })

  it('a raw temporal colour is a time scale with the default time format on its legend', () => {
    const vg = compileFrozen({ data: DATA, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, color: { field: 't', type: 'temporal' } } })
    expect(vg.scales.find((s: any) => s.name === 'color').type).toBe('time')
    expect(vg.legends[0].format).toBe('%b %d, %Y')
  })

  it('an aggregated pie filters the column it stacked, not a recomputed name', () => {
    const vg = compileFrozen({ data: DATA, mark: 'arc', encoding: { theta: { field: 'v', type: 'quantitative', aggregate: 'count' }, color: cn } })
    const tr = vg.data.find((d: any) => d.name === 'data_0').transform as any[]
    const stackField = tr.find((t) => t.type === 'stack').field as string
    expect(tr.find((t) => t.type === 'filter').expr).toContain(`datum["${stackField}"]`)
  })

  it('a time scale on a non-temporal colour falls back to linear, as vega-lite does', () => {
    const vg = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: cn, y: { field: 'v', type: 'quantitative' }, color: { field: 'v', type: 'quantitative', scale: { type: 'time' } } } })
    expect(vg.scales.find((s: any) => s.name === 'color').type).toBe('linear')
  })
})
