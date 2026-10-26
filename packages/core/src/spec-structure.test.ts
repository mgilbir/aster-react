import { describe, expect, it } from 'vitest'
import { isContinuous, isDiscretizing } from './scale.js'
import { CONTINUOUS_SCALE_TYPES, DISCRETIZING_SCALE_TYPES } from './spec-structure.js'

describe('spec-structure restates the scale registry\'s metadata', () => {
  const TYPES = [
    'identity', 'linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc',
    'sequential', 'sequential-linear', 'sequential-log', 'sequential-pow', 'sequential-sqrt', 'sequential-symlog',
    'diverging', 'diverging-linear', 'diverging-log', 'diverging-pow', 'diverging-sqrt', 'diverging-symlog',
    'quantile', 'quantize', 'threshold', 'bin-ordinal', 'ordinal', 'band', 'point', 'nonsense', '',
  ]
  for (const t of TYPES) {
    it(`${JSON.stringify(t)}: continuous and discretizing agree with scale.ts`, () => {
      expect(CONTINUOUS_SCALE_TYPES.has(t)).toBe(!!isContinuous(t))
      expect(DISCRETIZING_SCALE_TYPES.has(t)).toBe(!!isDiscretizing(t))
    })
  }
})
