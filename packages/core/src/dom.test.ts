// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg, patchSceneDom, sceneToDomDesc } from './index.js'
import type { SceneRoot } from './types.js'

const barSpec = (seedOffset: number) => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  background: 'white',
  autosize: 'none',
  data: [
    {
      name: 'table',
      values: [
        { cat: 'a', val: 3 + seedOffset },
        { cat: 'b', val: 7 },
        { cat: 'c', val: 5 + seedOffset },
      ],
    },
  ],
  scales: [
    { name: 'x', type: 'band', domain: { data: 'table', field: 'cat' }, range: 'width', padding: 0.2 },
    { name: 'y', type: 'linear', domain: { data: 'table', field: 'val' }, range: [{ signal: 'height' }, 0], nice: true },
  ],
  marks: [
    {
      type: 'rect',
      from: { data: 'table' },
      encode: {
        update: {
          x: { scale: 'x', field: 'cat' },
          width: { scale: 'x', band: 1 },
          y: { scale: 'y', field: 'val' },
          y2: { scale: 'y', value: 0 },
          fill: { value: 'steelblue' },
        },
      },
    },
  ],
})

function evalScene(seed: number): SceneRoot {
  return evaluateChart(compileChart(barSpec(seed) as never))
}

function structure(el: Element): unknown {
  return {
    tag: el.tagName,
    attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
    text: el.childElementCount === 0 ? el.textContent : undefined,
    children: [...el.children].map(structure),
  }
}

describe('patchSceneDom', () => {
  it('patched DOM structurally equals fresh renders across successive patches', () => {
    const container = document.createElement('div')
    container.innerHTML = renderSceneToSvg(evalScene(0))
    const svg = container.firstElementChild!

    // patch #1: establishes the descriptor cache (DOM-read fast path inside)
    patchSceneDom(svg, evalScene(2))
    const ref2 = document.createElement('div')
    ref2.innerHTML = renderSceneToSvg(evalScene(2))
    expect(structure(svg)).toEqual(structure(ref2.firstElementChild!))

    // patch #2: exercises the cached fast path
    patchSceneDom(svg, evalScene(3))
    const ref3 = document.createElement('div')
    ref3.innerHTML = renderSceneToSvg(evalScene(3))
    expect(structure(svg)).toEqual(structure(ref3.firstElementChild!))
  })

  it('keeps element identity across patches (no re-parse)', () => {
    const container = document.createElement('div')
    container.innerHTML = renderSceneToSvg(evalScene(0))
    const svg = container.firstElementChild!
    const pathsBefore = [...container.querySelectorAll('g.mark-rect path')]
    expect(pathsBefore.length).toBeGreaterThan(0)
    patchSceneDom(svg, evalScene(2))
    const pathsAfter = [...container.querySelectorAll('g.mark-rect path')]
    expect(pathsAfter.length).toBe(pathsBefore.length)
    for (let i = 0; i < pathsBefore.length; i++) {
      expect(pathsAfter[i]).toBe(pathsBefore[i]) // same DOM node, patched in place
    }
  })

  it('writes zero attributes when the scene is unchanged (and nonzero when it changes)', () => {
    const container = document.createElement('div')
    container.innerHTML = renderSceneToSvg(evalScene(0))
    const svg = container.firstElementChild!

    const ElementProto = Object.getPrototypeOf(
      Object.getPrototypeOf(container.querySelector('path')!),
    ) as { setAttribute: (...a: unknown[]) => void }
    // Patch the shared Element prototype so every element write is counted.
    const proto = container.ownerDocument.defaultView!.Element.prototype as unknown as {
      setAttribute: (...a: unknown[]) => void
    }
    const original = proto.setAttribute
    let writes: string[] = []
    proto.setAttribute = function (this: unknown, ...args: unknown[]) {
      writes.push(String(args[0]))
      return original.apply(this, args)
    } as (...a: unknown[]) => void
    try {
      void ElementProto
      patchSceneDom(svg, evalScene(0))
      expect(writes).toEqual([])
      // control: the spy works — a real change must produce writes
      patchSceneDom(svg, evalScene(2))
      expect(writes.length).toBeGreaterThan(0)
    } finally {
      proto.setAttribute = original
    }
  })

  it('updates only changed values on a data change', () => {
    const container = document.createElement('div')
    container.innerHTML = renderSceneToSvg(evalScene(0))
    const svg = container.firstElementChild!
    patchSceneDom(svg, evalScene(2))
    // bars grew => d attributes changed
    const ds = [...container.querySelectorAll('g.mark-rect path')].map((p) => p.getAttribute('d'))
    const reference = document.createElement('div')
    reference.innerHTML = renderSceneToSvg(evalScene(2))
    const refDs = [...reference.querySelectorAll('g.mark-rect path')].map((p) => p.getAttribute('d'))
    expect(ds).toEqual(refDs)
  })
})
