// @vitest-environment jsdom
/**
 * Bound inputs (`signal.bind`) against vega-view's own, in the same process (C227, C295, C156).
 *
 * Each signal definition is bound by a vega View (its generated inputs, in the view's element) and by `<Chart>` /
 * `<SvgChart interaction>`. Compared, control by control: what the input is (its type and, for a slider, min / max / step), the
 * value it shows, the options of a select or a radio group (their labels, the one selected or checked), the label of the
 * control; then each edit a user can make (choose every option, click every radio, type into a field, clear a number field,
 * tick a box, move a slider) and the signal value it writes.
 *
 * Deliberate differences, not compared: vega names every input after its signal, so two charts on one page share a radio
 * group and a spec chooses the field names a host <form> submits; Aster names only a radio group, uniquely per chart (C156,
 * tested here too). Vega copies every other key of `bind` onto a generated input as an attribute (an `on*` key becomes an
 * inline event handler); Aster takes the input types and attributes an input can safely have (docs/ARCHITECTURE.md,
 * "Deviations from Vega"). `bind.element` (an input placed elsewhere in the page) is not honoured, and reported.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
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

async function vegaOf(s: Spec): Promise<{ view: VegaView; root: Element }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => VegaView }).View(vega.parse(s as never), { renderer: 'svg' }).initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  return { view, root: host.querySelector('.vega-bindings')! }
}

const SHELLS: Array<[string, (p: Record<string, unknown>) => React.ReactElement]> = [
  ['<Chart>', (p) => React.createElement(Chart as never, p)],
  ['<SvgChart interaction>', (p) => React.createElement(SvgChart as never, { ...p, interaction })],
]

function asterOf(shell: (p: Record<string, unknown>) => React.ReactElement, s: Spec): { root: Element; signal: () => unknown } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  cleanups.push(() => act(() => r.unmount()))
  const ref = React.createRef<ChartHandle>()
  act(() => { r.render(shell({ spec: s, a11y: false, ref })) })
  return {
    root: host.querySelector('[data-aster-binds]')!,
    // (the value the chart drew with: the text mark shows toString(s), the scene's signal is the value itself)
    signal: () => (ref.current!.getScene() as unknown as { signalParams: Record<string, unknown> }).signalParams.s,
  }
}

describe('bound inputs show and write what vega-view\'s do', () => {
  for (const [name, signal] of SIGNALS) {
    it(name, async () => {
      for (const [shellName, shell] of SHELLS) {
        const v = await vegaOf(spec(signal))
        const a = asterOf(shell, spec(signal))
        const where = `${shellName}: ${name}`
        expect(describeControls(a.root), `${where}: controls`).toEqual(describeControls(v.root))
        if ((signal.bind as Spec).input !== 'radio') expect(labelOf(a.root), `${where}: label`).toBe(labelOf(v.root))
        const vEdits = edits(v.root)
        const aEdits = edits(a.root)
        expect(aEdits.map(([e]) => e)).toEqual(vEdits.map(([e]) => e))
        for (let i = 0; i < vEdits.length; i++) {
          vEdits[i]![1]()
          await tick()
          await v.view.runAsync()
          act(() => aEdits[i]![1]())
          expect(a.signal(), `${where}: after ${vEdits[i]![0]}`).toEqual(v.view.signal('s'))
          expect(describeControls(a.root), `${where}: controls after ${vEdits[i]![0]}`).toEqual(describeControls(v.root))
        }
      }
    })
  }
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
