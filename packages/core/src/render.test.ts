import { describe, it, expect } from 'vitest'
import { renderSceneToSvg } from './render.js'
import type { SceneRoot, SceneGroup, SceneItem } from './types.js'

function makeScene(overrides: Partial<SceneRoot> = {}): SceneRoot {
  const items: SceneGroup[] = overrides.items ?? []
  return {
    width: 400,
    height: 300,
    background: '#eee',
    frameStroke: '#888',
    padding: { top: 10, right: 20, bottom: 30, left: 40 },
    items,
    ...overrides,
  }
}

function makeLineGroup(pts: { x: number; y: number }[]): SceneGroup {
  return {
    marktype: 'line',
    name: 'lines',
    role: 'mark',
    items: pts.map((p) => ({ x: p.x, y: p.y } as SceneItem)),
  }
}

function makeRectGroup(x: number, y: number, w: number, h: number): SceneGroup {
  return {
    marktype: 'rect',
    name: 'rects',
    role: 'mark',
    items: [{ x, y, width: w, height: h } as SceneItem],
  }
}

describe('render', () => {
  it('emits <svg with root width/height and background', () => {
    const scene = makeScene()
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('<svg')
    expect(svg).toContain('width="400"')
    expect(svg).toContain('height="300"')
    expect(svg).toContain('width="400" height="300"')
    expect(svg).toContain('<rect width="400" height="300" fill="#eee"/>')
  })

  it('frame path starts with M0.5,0.5 when frameStroke present', () => {
    const scene = makeScene({ frameStroke: '#888' })
    const svg = renderSceneToSvg(scene)
    // plot area = (400-40-20) x (300-10-30) = 340 x 260
    // frame path when frameStroke present: M0.5,0.5h340v260h-340Z
    expect(svg).toContain('M0.5,0.5h340v260h-340Z')
  })

  it('frame path starts with M0,0 when frameStroke absent', () => {
    const scene = makeScene({ frameStroke: undefined, background: undefined })
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('M0,0h340v260h-340Z')
  })

  it('line mark group has a M..L.. path', () => {
    const scene = makeScene({
      background: undefined,
      frameStroke: undefined,
      items: [makeLineGroup([{ x: 0, y: 10 }, { x: 1, y: 20 }])],
    })
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('M0,10L1,20')
  })

  it('rect mark group has path with M..h..v..h..Z', () => {
    const scene = makeScene({
      background: undefined,
      frameStroke: undefined,
      items: [makeRectGroup(10, 20, 100, 50)],
    })
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('M10,20h100v50h-100Z')
  })
})
