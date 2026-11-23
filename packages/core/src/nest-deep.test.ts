// @vitest-environment node
/** `nest` over as many keys as a spec gives: iterative, so it neither overflows the stack nor walks up the tree per child (C486). */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { datasetsOfScene } from './runtime.js'
import './addon-transforms.js'
import type { VgSpec } from './types.js'

describe('nest with thousands of keys (C486)', () => {
  for (const keys of [1, 50, 30_000]) {
    it(`${keys} keys: the tree is built, every level, with nothing logged`, () => {
      const errors: unknown[] = []
      const spec = { data: [{ name: 't', values: [{ a: 1 }, { a: 2 }], transform: [{ type: 'nest', keys: Array(keys).fill('a'), generate: true }] }] } as unknown as VgSpec
      const scene = evaluateChart(compileChart(spec), { logger: { error: (e: unknown) => errors.push(e), warn: () => {} } } as never)
      expect(errors).toEqual([])
      // the two rows, then the interior nodes: the root, and per level one group for each of the two values
      expect(datasetsOfScene(scene).get('t')!.length).toBe(2 + 1 + 2 * keys)
    })
  }
})
