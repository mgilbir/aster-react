// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { bindSceneSignals, parseEventSelector, stampDatumAttrs } from './signals.js'
import type { VgSpec } from './types.js'

const specWithEventSignal = {
  width: 200,
  height: 100,
  signals: [
    {
      name: 'pointer',
      value: 0,
      on: [{ events: 'mousemove', update: 'event.x' }],
    },
    {
      name: 'clicked',
      value: false,
      on: [{ events: 'click', update: '!clicked' }],
    },
  ],
  data: [{ name: 't', values: [{ x: 1, y: 2 }] }],
  marks: [
    { type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 5 }, width: { value: 50 }, y: { value: 5 }, height: { value: 50 }, fill: { value: '#4c78a8' } } } },
  ],
} as unknown as VgSpec

/** jsdom dispatches clientX=0; monkey-patch getBoundingClientRect for view coords. */
function mount(): { host: HTMLDivElement; svg: SVGSVGElement } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const chart = compileChart(specWithEventSignal)
  const scene = evaluateChart(chart)
  const svg = document.createElement('div')
  svg.innerHTML = renderSceneToSvg(scene)
  host.appendChild(svg.firstElementChild as SVGSVGElement)
  const el = host.querySelector('svg') as SVGSVGElement
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } as DOMRect)
  return { host, svg: el }
}

describe('event-driven signals', () => {
  it('parses space-separated event selectors (supported subset)', () => {
    expect(parseEventSelector('mousemove click wheel')).toEqual(['mousemove', 'click', 'wheel'])
    expect(parseEventSelector('mouseover')).toEqual(['mouseover'])
  })

  it('binds mousemove -> signal update with view coordinates', () => {
    const { host, svg } = mount()
    let last: { name: string; value: unknown } | null = null
    const scene = evaluateChart(compileChart(structuredClone(specWithEventSignal)))
    const binding = bindSceneSignals(svg, scene, {}, {
      onSignal: (name, value) => { last = { name, value } },
    })
    svg.dispatchEvent(new MouseEvent('mousemove', { clientX: 42, clientY: 10, bubbles: true }))
    expect(last).toEqual({ name: 'pointer', value: 42 })
    binding.detach()
    void host
  })

  it('click stream toggles the signal (expr with signal refs)', () => {
    const { svg } = mount()
    let last = null as null | { name: string; value: unknown }
    const binding = bindSceneSignals(svg, evaluateChart(compileChart(structuredClone(specWithEventSignal))), {}, {
      onSignal: (name, value) => { last = { name, value } },
    })
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(last).toEqual({ name: 'clicked', value: true })
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(last!.value).toBe(false)
    binding.detach()
  })

  it('recovers the hovered mark datum into the event context', () => {
    const spec = {
      width: 100, height: 100,
      signals: [{ name: 'hit', value: '', on: [{ events: 'click', update: 'isValid(datum) ? datum.tag + "" : "none"' }] }],
      data: [{ name: 't', values: [{ tag: 'A' }] }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 50 }, height: { value: 50 } } } }],
    } as unknown as VgSpec
    const host = document.createElement('div')
    document.body.appendChild(host)
    const chart = compileChart(spec)
    const scene = evaluateChart(chart)
    stampDatumAttrs(scene.items)
    host.innerHTML = renderSceneToSvg(scene)
    const svg = host.querySelector('svg') as SVGSVGElement
    // the rendered rect must carry data-datum
    expect(svg.querySelector('[data-datum]')).toBeTruthy()
    let captured: unknown
    const binding = bindSceneSignals(svg, scene, {}, {
      onSignal: (name, value) => { if (name === 'hit') captured = value },
    })
    const rect = svg.querySelector('.mark-rect path') ?? svg.querySelector('path')
    rect!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    binding.detach()
    expect(captured).toBe('A')
  })

  it('setSignal resolves dependent updates to a fixed point', () => {
    const spec = {
      signals: [
        { name: 'a', value: 1 },
        { name: 'b', value: 0, update: 'a * 2' },
      ],
    } as unknown as VgSpec
    const { svg } = mount()
    let got: Record<string, unknown> | null = null
    const binding = bindSceneSignals(svg, evaluateChart(compileChart(spec)), {}, {
      onSignal: (name, value, all) => { if (name === 'a') got = all },
    })
    binding.setSignal('a', 5)
    expect(got!.b).toBe(10)
    binding.detach()
    void svg
  })
})
