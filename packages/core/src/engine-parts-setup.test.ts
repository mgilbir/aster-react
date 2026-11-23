// @vitest-environment node
/**
 * A core unit test is given the parts of the engine filled (scripts/vitest-core-parts.setup.mjs), and `installAllParts` fills them
 * again where a test emptied them: every slot, the canvas renderer and the signal loop included, so that a test that reads
 * `part('signals')` gets what the headers promise (C620).
 */
import { describe, expect, it } from 'vitest'
import { ENGINE_PARTS, partLoaded, withdrawParts } from './engine-parts.js'
import { installAllParts } from './install-parts.testlib.js'

describe('the parts a core test is given', () => {
  it('every part of the engine is in its slot after the setup', () => {
    expect(ENGINE_PARTS.filter((p) => !partLoaded(p))).toEqual([])
  })

  it('installAllParts fills every slot a test emptied', () => {
    const restore = withdrawParts(ENGINE_PARTS)
    try {
      expect(ENGINE_PARTS.filter((p) => partLoaded(p))).toEqual([])
      installAllParts()
      expect(ENGINE_PARTS.filter((p) => !partLoaded(p))).toEqual([])
    } finally {
      restore()
    }
  })
})
