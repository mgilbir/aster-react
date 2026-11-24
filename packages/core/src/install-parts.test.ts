import { describe, expect, it } from 'vitest'
import { ENGINE_PARTS, partLoaded, withdrawParts } from './engine-parts.js'
import { installAllParts } from './install-parts.testlib.js'

describe('installAllParts (C737)', () => {
  it('fills the slot of every part ENGINE_PARTS lists', () => {
    const restore = withdrawParts(ENGINE_PARTS)
    try {
      expect(ENGINE_PARTS.filter((name) => partLoaded(name))).toEqual([])
      installAllParts()
      expect(ENGINE_PARTS.filter((name) => !partLoaded(name))).toEqual([])
    } finally {
      restore()
    }
  })
})
