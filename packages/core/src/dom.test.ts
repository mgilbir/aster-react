// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { patchSceneDom, renderSceneToDomElement, sceneToDomDesc } from './addon-dom.js'
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

describe('patchSceneDom append fast path', () => {
  const rows = (n: number, from = 0): Array<{ x: number; y: number }> =>
    Array.from({ length: n }, (_, i) => ({ x: ((from + i) % 97) / 97, y: ((from + i) % 23) / 2 }))

  const spec = {
    width: 200, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 't', values: [] as Array<{ x: number; y: number }> }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 1], range: [0, 200] },
      { name: 'y', type: 'linear', domain: [0, 12], range: [100, 0] },
    ],
    marks: [{
      type: 'symbol', from: { data: 't' },
      encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 20 } } },
    }],
  }

  it('creates only the new item and leaves existing elements untouched', async () => {
    const { createChartStream } = await import('./stream.js')
    const stream = createChartStream(spec as never, { capacity: 4 })
    stream.push({ data: { t: rows(200) } })
    const first = stream.flush()!
    const svg = renderSceneToDomElement(first.scene)
    const group = svg.querySelector('g.mark-symbol')!
    expect(group.childElementCount).toBe(200)
    const firstChild = group.firstElementChild
    const tailChild = group.lastElementChild

    stream.push({ append: { t: rows(1, 200) } })
    const next = stream.flush()!

    // Count patcher bookkeeping writes (LAST.set per visited element) as a proxy
    // for how much of the tree was walked: 200+ means the append re-walked the
    // whole mark group, a handful means it went straight to the tail.
    const original = WeakMap.prototype.set
    let sets = 0
    WeakMap.prototype.set = function (this: WeakMap<object, unknown>, ...args: [object, unknown]) {
      sets++
      return original.apply(this, args as never)
    }
    try {
      patchSceneDom(svg, next.scene)
    } finally {
      WeakMap.prototype.set = original
    }

    expect(group.childElementCount).toBe(201)
    expect(group.firstElementChild).toBe(firstChild)
    expect(group.children[199]).toBe(tailChild)
    expect(sets).toBeLessThan(30)

    // The appended element matches a full render of the same scene.
    const reference = document.createElement('div')
    reference.innerHTML = renderSceneToSvg(next.scene)
    const refLast = reference.querySelector('g.mark-symbol')!.lastElementChild!
    const gotLast = group.lastElementChild!
    expect(gotLast.tagName).toBe(refLast.tagName)
    expect([...gotLast.attributes].map((a) => [a.name, a.value]).sort())
      .toEqual([...refLast.attributes].map((a) => [a.name, a.value]).sort())
  })
})
