// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import './vl' // Vega-Lite is opt-in: this registers the compiler
import { loadTransitions } from './transition'
import { forEachVariant } from './testing/variants'

// Issue #127's acceptance set: a bar chart, a stacked bar chart, a multi-series line chart and a heatmap (Vega-Lite, compiled
// by @aster-charts/vl), each given new rows with values changed, categories added and categories removed. Each change is
// drawn as frames whose middle one lies between the two pictures (in the direction of the change), and ends on exactly the
// svg a fresh chart of the new rows draws.

type Row = Record<string, unknown>
const vl = (body: Record<string, unknown>): never => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200, height: 100, data: { name: 'table' }, ...body,
}) as never

const BAR = vl({ mark: 'bar', encoding: { x: { field: 'cat', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, key: { field: 'cat' } } })
const STACKED = vl({
  mark: 'bar',
  encoding: { x: { field: 'cat', type: 'nominal' }, y: { field: 'v', type: 'quantitative', aggregate: 'sum' }, color: { field: 'grp', type: 'nominal' }, key: { field: 'id' } },
})
const LINES = vl({ mark: 'line', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'series', type: 'nominal' } } })
const HEATMAP = vl({
  mark: 'rect',
  encoding: { x: { field: 'col', type: 'nominal' }, y: { field: 'row', type: 'nominal' }, color: { field: 'v', type: 'quantitative' }, key: { field: 'id' } },
})

const LINEAR = { duration: 300, easing: 'linear' } as const

interface Drawn { label: string; d: string; opacity: number; fill: string }
/** The marks drawn in `selector`, with the description they carry (vega-lite's aria-label: `cat: A; v: 3`). */
function drawn(container: HTMLElement, selector: string): Drawn[] {
  return [...container.querySelectorAll(`${selector} path`)].map((p) => ({
    label: p.getAttribute('aria-label') ?? '',
    d: p.getAttribute('d') ?? '',
    opacity: p.hasAttribute('opacity') ? Number(p.getAttribute('opacity')) : 1,
    fill: p.getAttribute('fill') ?? '',
  }))
}
const one = (list: Drawn[], text: string): Drawn => {
  const found = list.filter((m) => m.label.includes(text))
  if (found.length !== 1) throw new Error(`expected one mark labelled ${text}, found ${found.length}: ${list.map((m) => m.label).join(' | ')}`)
  return found[0]!
}
const has = (list: Drawn[], text: string): boolean => list.some((m) => m.label.includes(text))
/** A rect path `M x,y h w v h ...`: [x, y, w, h]. */
const box = (m: Drawn): number[] => {
  const r = /^M([-\d.e]+),([-\d.e]+)h([-\d.e]+)v([-\d.e]+)/.exec(m.d)
  if (!r) throw new Error(`not a rect path: ${m.d}`)
  return r.slice(1, 5).map(Number)
}
/** The first point of a path. */
const firstPoint = (m: Drawn): number[] => (/^M([-\d.e]+),([-\d.e]+)/.exec(m.d) ?? []).slice(1, 3).map(Number)
const rgb = (fill: string): number[] => {
  if (fill.startsWith('#')) return [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16))
  return (/rgba?\(([^)]*)\)/.exec(fill)?.[1] ?? '').split(',').slice(0, 3).map(Number)
}
const strictlyBetween = (v: number, a: number, b: number): void => {
  expect(v).toBeGreaterThan(Math.min(a, b))
  expect(v).toBeLessThan(Math.max(a, b))
}

beforeAll(async () => { await loadTransitions() })

forEachVariant(['svg'], (Chart) => {
  describe('the acceptance set animates and settles', () => {
    const roots: Root[] = []
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
    })
    afterEach(() => {
      for (const r of roots.splice(0)) act(() => r.unmount())
      vi.useRealTimers()
      document.body.innerHTML = ''
    })
    const mount = (spec: never, rows: Row[], transition?: typeof LINEAR): { container: HTMLElement; root: Root } => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      roots.push(root)
      act(() => { root.render(<Chart spec={spec} data={{ table: rows }} width={200} height={100} transition={transition} />) })
      return { container, root }
    }
    /** The pictures before, half way and after; the last is checked against a fresh chart of the new rows. */
    const run = (spec: never, from: Row[], to: Row[], selector: string): { before: Drawn[]; mid: Drawn[]; after: Drawn[] } => {
      const { container, root } = mount(spec, from, LINEAR)
      const before = drawn(container, selector)
      act(() => { root.render(<Chart spec={spec} data={{ table: to }} width={200} height={100} transition={LINEAR} />) })
      act(() => { vi.advanceTimersByTime(150) })
      const mid = drawn(container, selector)
      act(() => { vi.advanceTimersByTime(300) })
      const after = drawn(container, selector)
      expect(vi.getTimerCount()).toBe(0)
      expect(container.querySelector('svg')!.outerHTML).toBe(mount(spec, to).container.querySelector('svg')!.outerHTML)
      return { before, mid, after }
    }

    describe('bar chart', () => {
      const rows = [{ cat: 'A', v: 3 }, { cat: 'B', v: 5 }, { cat: 'C', v: 4 }]
      it('values changed: a bar grows between its two heights', () => {
        const { before, mid, after } = run(BAR, rows, [{ cat: 'A', v: 3 }, { cat: 'B', v: 2 }, { cat: 'C', v: 4 }], '.mark-rect')
        strictlyBetween(box(one(mid, 'cat: B'))[3]!, box(one(before, 'cat: B'))[3]!, box(one(after, 'cat: B'))[3]!)
      })
      it('a category added: its bar grows out of the baseline, the others slide to their new band', () => {
        const { before, mid, after } = run(BAR, rows, [...rows, { cat: 'D', v: 2 }], '.mark-rect')
        const [, y, , h] = box(one(mid, 'cat: D'))
        strictlyBetween(h!, 0, box(one(after, 'cat: D'))[3]!)
        expect(y! + h!).toBeCloseTo(100) // on the zero line
        strictlyBetween(box(one(mid, 'cat: B'))[0]!, box(one(before, 'cat: B'))[0]!, box(one(after, 'cat: B'))[0]!)
      })
      it('a category removed: its bar shrinks into the baseline and is gone at the end', () => {
        const { before, mid, after } = run(BAR, rows, rows.slice(0, 2), '.mark-rect')
        strictlyBetween(box(one(mid, 'cat: C'))[3]!, 0, box(one(before, 'cat: C'))[3]!)
        expect(has(after, 'cat: C')).toBe(false)
      })
    })

    describe('stacked bar chart', () => {
      const rows = ['A', 'B'].flatMap((cat) => ['g1', 'g2'].map((grp, i) => ({ id: cat + grp, cat, grp, v: 2 + i })))
      it('values changed: a segment moves between its two extents', () => {
        const to = rows.map((r) => (r.id === 'Ag2' ? { ...r, v: 6 } : r))
        const { before, mid, after } = run(STACKED, rows, to, '.mark-rect')
        strictlyBetween(box(one(mid, 'id: Ag2'))[3]!, box(one(before, 'id: Ag2'))[3]!, box(one(after, 'id: Ag2'))[3]!)
      })
      it('a category added: the new segments fade in (a stack shares no baseline)', () => {
        const { mid } = run(STACKED, rows, [...rows, { id: 'Ag3', cat: 'A', grp: 'g3', v: 1 }, { id: 'Bg3', cat: 'B', grp: 'g3', v: 1 }], '.mark-rect')
        strictlyBetween(one(mid, 'id: Ag3').opacity, 0, 1)
      })
      it('a category removed: its segments fade out and are gone at the end', () => {
        const { mid, after } = run(STACKED, rows, rows.filter((r) => r.grp === 'g1'), '.mark-rect')
        strictlyBetween(one(mid, 'id: Bg2').opacity, 0, 1)
        expect(has(after, 'grp: g2')).toBe(false)
      })
    })

    describe('multi-series line chart', () => {
      const rows = ['p', 'q'].flatMap((series, s) => [0, 1, 2].map((x) => ({ series, x, v: x + s * 3 })))
      it('values changed: a line moves point by point', () => {
        const to = rows.map((r) => (r.series === 'q' ? { ...r, v: (r.v as number) - 2 } : r))
        const { before, mid, after } = run(LINES, rows, to, '.mark-line')
        strictlyBetween(firstPoint(one(mid, 'series: q'))[1]!, firstPoint(one(before, 'series: q'))[1]!, firstPoint(one(after, 'series: q'))[1]!)
      })
      it('a series added: it fades in while the others move to the new scale', () => {
        const { before, mid, after } = run(LINES, rows, [...rows, ...[0, 1, 2].map((x) => ({ series: 'r', x, v: 9 }))], '.mark-line')
        strictlyBetween(one(mid, 'series: r').opacity, 0, 1)
        strictlyBetween(firstPoint(one(mid, 'series: q'))[1]!, firstPoint(one(before, 'series: q'))[1]!, firstPoint(one(after, 'series: q'))[1]!)
      })
      it('a series removed: it fades out and is gone at the end', () => {
        const { mid, after } = run(LINES, rows, rows.filter((r) => r.series === 'p'), '.mark-line')
        strictlyBetween(one(mid, 'series: q').opacity, 0, 1)
        expect(has(after, 'series: q')).toBe(false)
      })
    })

    describe('heatmap', () => {
      const rows = ['r1', 'r2'].flatMap((row, i) => ['c1', 'c2'].map((col, j) => ({ id: row + col, row, col, v: i * 2 + j })))
      it('values changed: a cell\'s colour mixes between its two colours', () => {
        const to = rows.map((r) => (r.id === 'r1c1' ? { ...r, v: 3 } : r))
        const { before, mid, after } = run(HEATMAP, rows, to, '.mark-rect')
        const [m, b, a] = [mid, before, after].map((l) => rgb(one(l, 'col: c1; row: r1').fill))
        expect(m).not.toEqual(b)
        expect(m).not.toEqual(a)
        for (let i = 0; i < 3; i++) {
          expect(m![i]).toBeGreaterThanOrEqual(Math.min(b![i]!, a![i]!) - 1)
          expect(m![i]).toBeLessThanOrEqual(Math.max(b![i]!, a![i]!) + 1)
        }
      })
      it('a category added: the new cells fade in (cells share no baseline)', () => {
        const { mid } = run(HEATMAP, rows, [...rows, { id: 'r3c1', row: 'r3', col: 'c1', v: 1 }, { id: 'r3c2', row: 'r3', col: 'c2', v: 2 }], '.mark-rect')
        strictlyBetween(one(mid, 'col: c1; row: r3').opacity, 0, 1)
        expect(box(one(mid, 'col: c1; row: r3'))[3]).toBeGreaterThan(0) // full size, not grown
      })
      it('a category removed: its cells fade out and are gone at the end', () => {
        const { mid, after } = run(HEATMAP, rows, rows.filter((r) => r.row === 'r1'), '.mark-rect')
        strictlyBetween(one(mid, 'col: c2; row: r2').opacity, 0, 1)
        expect(has(after, 'row: r2')).toBe(false)
      })
    })
  })
})
