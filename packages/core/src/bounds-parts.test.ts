import { describe, it, expect } from 'vitest'
import { Bounds, itemBounds } from './bounds.js'
import { partLoaded, withdrawParts } from './engine-parts.js'
import type { SceneItem } from './types.js'

describe('the bounds of a shape that is clipped away entirely need no path reader', () => {
  // (a geoshape whose projection leaves nothing of it is an empty path; the path reader is a part a spec of shapes need not carry --
  // specNeeds names it for a `path` mark and a custom symbol --, so measuring nothing must not ask for it: the gallery's
  // parts-needed gate found eight geo specs that did)
  it.each(['shape', 'path'])('a %s item of an empty path', (type) => {
    const restore = withdrawParts(['svgpath'])
    try {
      expect(partLoaded('svgpath')).toBe(false)
      const b = itemBounds(new Bounds(), type, { path: '', stroke: 'black', strokeWidth: 2, x: 10, y: 10 } as unknown as SceneItem)
      expect(b.x1).toBe(Number.MAX_VALUE)
      expect(b.x2).toBe(-Number.MAX_VALUE)
    } finally { restore() }
  })
  it('a path that is not empty still asks for the reader (and the part is what a spec with path marks names)', () => {
    const restore = withdrawParts(['svgpath'])
    try {
      expect(() => itemBounds(new Bounds(), 'path', { path: 'M0,0L10,10', x: 0, y: 0 } as unknown as SceneItem)).toThrow(/"svgpath" part/)
    } finally { restore() }
  })
})
