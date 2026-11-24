// @vitest-environment jsdom
/**
 * Bound inputs (`signal.bind`) against vega-view's own, in the same process (C227, C295, C156).
 *
 * Each signal definition is bound by a vega View (its generated inputs, in the view's element) and by `<Chart>` /
 * `<SvgChart interaction>`. Compared, control by control: what the input is (its type and, for a slider, min / max / step), the
 * value it shows, the options of a select or a radio group (their labels, the one selected or checked), the label of the
 * control; then each edit a user can make (choose every option, click every radio, type into a field, clear a number field,
 * tick a box, move a slider) and the signal value it writes. Each case runs with the accessible tree on (the default) and off,
 * the controls are read from the chart's whole element and found again before every edit (as a person, or a browser test,
 * finds them), so a chart that draws a control twice, or keeps a stale one, differs from vega's one control per signal.
 * Vega-Lite selections bound to inputs (the cases of the browser selections gate) are compared the same way, on the bound
 * signal and the selection tuple it makes.
 *
 * Deliberate differences, not compared: vega names every input after its signal, so two charts on one page share a radio
 * group and a spec chooses the field names a host <form> submits; Aster names only a radio group, uniquely per chart (C156,
 * tested here too). Vega copies every other key of `bind` onto a generated input as an attribute (an `on*` key becomes an
 * inline event handler); Aster takes the input types and attributes an input can safely have (docs/ARCHITECTURE.md,
 * "Deviations from Vega"). `bind.element` (an input placed elsewhere in the page) is not honoured, and reported.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Chart, type ChartHandle } from '@aster-charts/react'
import { SvgChart } from '@aster-charts/react/lite'
import { interaction } from '@aster-charts/react/interaction'

type Spec = Record<string, unknown>
type VegaView = { initialize(el: Element): VegaView; runAsync(): Promise<unknown>; signal(name: string): unknown; finalize(): void }

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Signal definitions with a `bind`, each a case. */
const SIGNALS: Array<[string, Spec]> = [
  ['range with min, max, step', { name: 's', value: 4, bind: { input: 'range', min: 0, max: 10, step: 2 } }],
  ['range with no value (starts mid-range)', { name: 's', bind: { input: 'range', min: 1970, max: 1980, step: 1 } }],
  ['range with no step (tickStep of 100)', { name: 's', value: 0.3, bind: { input: 'range', min: 0, max: 1 } }],
  ['range with no bounds', { name: 's', value: 250, bind: { input: 'range' } }],
  ['range with a name', { name: 's', value: 2, bind: { input: 'range', min: 0, max: 5, step: 1, name: 'Size ' } }],
  ['select of strings', { name: 's', value: 'b', bind: { input: 'select', options: ['a', 'b', 'c'] } }],
  ['select with labels', { name: 's', value: 2, bind: { input: 'select', options: [1, 2], labels: ['One', 'Two'] } }],
  ['select with fewer labels than options', { name: 's', value: 3, bind: { input: 'select', options: [1, 2, 3], labels: ['One'] } }],
  ['select of arrays (line_params)', { name: 's', value: [1, 0], bind: { input: 'select', options: [[1, 0], [8, 8], [8, 4], [4, 4], [4, 2], [2, 1], [1, 1]] } }],
  ['select with null (selection_bind_origin)', { name: 's', value: null, bind: { input: 'select', options: [null, 'Europe', 'Japan', 'USA'] } }],
  ['select of numbers matching a string value', { name: 's', value: '2', bind: { input: 'select', options: [1, 2, 3] } }],
  ['select whose value is no option', { name: 's', value: 'z', bind: { input: 'select', options: ['a', 'b'] } }],
  ['select of booleans', { name: 's', value: false, bind: { input: 'select', options: [true, false] } }],
  ['radio of strings', { name: 's', value: 'y', bind: { input: 'radio', options: ['x', 'y', 'z'] } }],
  ['radio with labels', { name: 's', value: 1, bind: { input: 'radio', options: [0, 1], labels: ['off', 'on'] } }],
  ['checkbox on', { name: 's', value: true, bind: { input: 'checkbox' } }],
  ['checkbox off', { name: 's', value: false, bind: { input: 'checkbox' } }],
  ['text', { name: 's', value: 'abc', bind: { input: 'text' } }],
  ['search with a placeholder (param_search_input)', { name: 's', value: '', bind: { input: 'search', placeholder: 'Car model', autocomplete: 'off' } }],
  ['number', { name: 's', value: 5, bind: { input: 'number' } }],
  ['color', { name: 's', value: '#ff0000', bind: { input: 'color' } }],
  ['date', { name: 's', value: '2024-03-05', bind: { input: 'date' } }],
  ['text with maxlength', { name: 's', value: 'ab', bind: { input: 'text', maxlength: 4 } }],
]

const spec = (signal: Spec): Spec => ({
  width: 50, height: 20, padding: 0, autosize: 'none', signals: [signal],
  marks: [{ type: 'text', encode: { update: { text: { signal: 'toString(s)' } } } }],
})

/** What a person sees of the bound controls in `root`. */
function describeControls(root: Element): unknown[] {
  return [...root.querySelectorAll('input, select')].map((n) => {
    if (n instanceof HTMLSelectElement) {
      return { kind: 'select', options: [...n.options].map((o) => o.textContent), selected: n.selectedIndex }
    }
    const i = n as HTMLInputElement
    const base = { kind: 'input', type: i.type, label: (i.closest('label')?.textContent ?? '').trim() }
    if (i.type === 'radio' || i.type === 'checkbox') return { ...base, checked: i.checked }
    if (i.type === 'range') return { ...base, min: i.getAttribute('min'), max: i.getAttribute('max'), step: i.getAttribute('step'), value: i.value }
    return { ...base, value: i.value, placeholder: i.getAttribute('placeholder'), maxLength: i.getAttribute('maxlength') }
  })
}
/** The text of the label (vega's `.vega-bind-name`, Aster's first span), for a control that is not a radio. */
const labelOf = (root: Element): string | undefined => (root.querySelector('.vega-bind-name, [data-signal] > span')?.textContent ?? undefined)

/** Every edit a person can make to the controls in `root`: each applied in turn. */
function edits(root: Element): Array<[string, () => void]> {
  const out: Array<[string, () => void]> = []
  const setValue = (el: HTMLInputElement | HTMLSelectElement, v: string, type: string): void => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event(type, { bubbles: true }))
  }
  for (const n of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
    if (n instanceof HTMLSelectElement) {
      for (let i = n.options.length - 1; i >= 0; i--) out.push([`select #${i}`, () => { n.selectedIndex = i; n.dispatchEvent(new Event('change', { bubbles: true })) }])
    } else if (n.type === 'radio') {
      out.push([`radio ${n.value}`, () => { n.click() }])
    } else if (n.type === 'checkbox') {
      out.push(['toggle', () => { n.click() }], ['toggle back', () => { n.click() }])
    } else if (n.type === 'range') {
      out.push(['slide to max', () => setValue(n, n.max, 'input')], ['slide to min', () => setValue(n, n.min, 'input')])
    } else if (n.type === 'number') {
      out.push(['type 12', () => setValue(n, '12', 'input')], ['clear', () => setValue(n, '', 'input')])
    } else if (n.type === 'color') {
      out.push(['pick', () => setValue(n, '#00ff00', 'input')])
    } else if (n.type === 'date') {
      out.push(['pick', () => setValue(n, '2025-01-02', 'input')])
    } else {
      out.push(['type', () => setValue(n, 'ford', 'input')], ['clear', () => setValue(n, '', 'input')])
    }
  }
  return out
}

async function vegaOf(s: Spec): Promise<{ view: VegaView; root: Element; host: Element }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => VegaView }).View(vega.parse(s as never), { renderer: 'svg' }).initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  return { view, root: host.querySelector('.vega-bindings')!, host }
}

const SHELLS: Array<[string, (p: Record<string, unknown>) => React.ReactElement]> = [
  ['<Chart>', (p) => React.createElement(Chart as never, p)],
  ['<SvgChart interaction>', (p) => React.createElement(SvgChart as never, { ...p, interaction })],
]

/** The accessible tree on (the default) and off: the bound inputs share the chart's element with it. */
const A11Y: Array<[string, Record<string, unknown>]> = [['a11y on', {}], ['a11y off', { a11y: false }]]

function asterOf(
  shell: (p: Record<string, unknown>) => React.ReactElement, s: Spec, props: Record<string, unknown> = { a11y: false },
): { root: Element; host: Element; signal: (name?: string) => unknown } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  cleanups.push(() => act(() => r.unmount()))
  const ref = React.createRef<ChartHandle>()
  act(() => { r.render(shell({ spec: s, ...props, ref })) })
  return {
    root: host.querySelector('[data-aster-binds]')!,
    host,
    // (the value the chart drew with: the text mark shows toString(s), the scene's signal is the value itself)
    signal: (name = 's') => (ref.current!.getScene() as unknown as { signalParams: Record<string, unknown> }).signalParams[name],
  }
}

/** A value as a signal holds it, less symbol-keyed properties (vega tags a tuple it made with `Symbol(vega_id)`, its own bookkeeping). */
const observable = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(observable)
  if (x === null || typeof x !== 'object' || Object.getPrototypeOf(x) !== Object.prototype) return x
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, observable(v)]))
}

/**
 * Applies vega's edits to vega's controls and the same edits to the chart's, one at a time, each found again in the chart's
 * whole element just before it is made, and compares the controls and the `names` signals after each.
 */
async function compareEdits(
  where: string, v: { view: VegaView; host: Element }, a: { host: Element; signal: (name?: string) => unknown }, names: readonly string[],
  rounds = 1,
): Promise<void> {
  expect(describeControls(a.host), `${where}: controls`).toEqual(describeControls(v.host))
  const labels = edits(v.host).map(([e]) => e)
  expect(edits(a.host).map(([e]) => e), `${where}: edits`).toEqual(labels)
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < labels.length; i++) {
      const step = `${labels[i]}${rounds > 1 ? ` (round ${round + 1})` : ''}`
      edits(v.host)[i]![1]()
      await tick()
      await v.view.runAsync()
      const mine = edits(a.host)
      expect(mine.map(([e]) => e), `${where}: edits before ${step}`).toEqual(labels)
      act(() => mine[i]![1]())
      for (const name of names) expect(observable(a.signal(name)), `${where}: ${name} after ${step}`).toEqual(observable(v.view.signal(name)))
      expect(describeControls(a.host), `${where}: controls after ${step}`).toEqual(describeControls(v.host))
    }
  }
}

describe('bound inputs show and write what vega-view\'s do', () => {
  for (const [name, signal] of SIGNALS) {
    it(name, async () => {
      for (const [shellName, shell] of SHELLS) {
        for (const [a11yName, props] of A11Y) {
          const v = await vegaOf(spec(signal))
          const a = asterOf(shell, spec(signal), props)
          const where = `${shellName}, ${a11yName}: ${name}`
          if ((signal.bind as Spec).input !== 'radio') expect(labelOf(a.root), `${where}: label`).toBe(labelOf(v.root))
          await compareEdits(where, v, a, ['s'], 2)
        }
      }
    })
  }
})

/** Vega-Lite point selections bound to an input (the browser selections gate's cases), compiled by vega-lite itself. */
const ROWS = [
  { a: 1, b: 3, c: 'x' }, { a: 2, b: 5, c: 'y' }, { a: 3, b: 2, c: 'x' }, { a: 4, b: 6, c: 'z' }, { a: 5, b: 4, c: 'y' }, { a: 6, b: 7, c: 'z' },
]
const boundSelection = (field: 'a' | 'c', bind: Spec): Spec => (vl.compile({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json', data: { values: ROWS }, width: 120, height: 80,
  params: [{ name: 'pick', select: { type: 'point', fields: [field] }, bind }],
  mark: 'point',
  encoding: {
    x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
    color: { condition: { param: 'pick', field: 'c', type: 'nominal' }, value: 'lightgray' },
  },
} as never).spec as unknown as Spec)
const BOUND_SELECTIONS: Array<[string, 'a' | 'c', Spec]> = [
  ['radio', 'c', { input: 'radio', options: ['x', 'y', 'z'] }],
  ['select', 'c', { input: 'select', options: ['x', 'y', 'z'] }],
  ['range', 'a', { input: 'range', min: 1, max: 6, step: 1 }],
  ['checkbox', 'a', { input: 'checkbox' }],
]

describe('Vega-Lite selections bound to inputs write what vega-view\'s do', () => {
  for (const [name, field, bind] of BOUND_SELECTIONS) {
    it(name, async () => {
      const s = boundSelection(field, bind)
      for (const [shellName, shell] of SHELLS) {
        for (const [a11yName, props] of A11Y) {
          const v = await vegaOf(s)
          const a = asterOf(shell, s, props)
          await compareEdits(`${shellName}, ${a11yName}: ${name}`, v, a, [`pick_${field}`, 'pick_tuple'], 2)
        }
      }
    })
  }
})

describe('`debounce` delays the write as vega-view\'s does', () => {
  it('a typed value reaches the signal only after the delay', async () => {
    const s = spec({ name: 's', value: 'a', bind: { input: 'text', debounce: 60 } })
    for (const [shellName, shell] of SHELLS) {
      const v = await vegaOf(s)
      const a = asterOf(shell, s)
      const type = (root: Element): void => {
        const el = root.querySelector('input')!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, 'typed')
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      type(v.root)
      act(() => type(a.root))
      await tick()
      await v.view.runAsync()
      expect([shellName, a.signal(), v.view.signal('s')]).toEqual([shellName, 'a', 'a'])
      await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
      await v.view.runAsync()
      expect([shellName, a.signal(), v.view.signal('s')]).toEqual([shellName, 'typed', 'typed'])
    }
  })
})

describe('the radio groups of two charts on a page are their own (C156)', () => {
  it('choosing in one chart leaves the other as it was', () => {
    const s = spec({ name: 's', value: 'a', bind: { input: 'radio', options: ['a', 'b'] } })
    const one = asterOf(SHELLS[0]![1], s)
    const two = asterOf(SHELLS[0]![1], s)
    const radios = (r: Element): boolean[] => [...r.querySelectorAll<HTMLInputElement>('input[type=radio]')].map((i) => i.checked)
    act(() => two.root.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!.click())
    expect(radios(one.root)).toEqual([true, false])
    expect(radios(two.root)).toEqual([false, true])
    expect(two.signal()).toBe('b')
    expect(one.signal()).toBe('a')
  })
})

describe('only safe input types and attributes reach a generated input', () => {
  it('an on* key, a src and an unknown type do not', () => {
    const s = spec({ name: 's', value: 'x', bind: { input: 'image', onfocus: 'alert(1)', src: 'https://example.com/x.png', formaction: 'https://example.com', placeholder: 'p', autofocus: true } })
    const a = asterOf(SHELLS[0]![1], s)
    const input = a.root.querySelector('input')!
    expect(input.type).toBe('text')
    for (const attr of ['onfocus', 'src', 'formaction', 'autofocus']) expect(input.hasAttribute(attr), attr).toBe(false)
    expect(input.getAttribute('placeholder')).toBe('p')
  })
})
