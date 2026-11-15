/**
 * The parts of the engine for core's own unit tests.
 *
 * Core's modules read the parts most charts never run (the legend builder, the path reader, the regular-expression screen, the
 * pulse path, ...) from slots that the public entries fill (packages/core/src/engine-parts.ts). A unit test that imports a module
 * of packages/core/src directly is given them filled the same way, so that it tests what the public entries run. A test of the lean
 * path itself empties the slots it needs empty (`withdrawParts`). Tests of the other packages run against core's dist, whose
 * entries fill the slots themselves.
 *
 * A test file that mocks a module (`vi.mock`) is left alone: importing the parts here would load the modules it mocks before its
 * mocks apply. Such a file imports what it needs itself (its `vi.mock` calls are hoisted above its own imports).
 */
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'

const testPath = expect.getState().testPath ?? ''
if (/[\\/]packages[\\/]core[\\/]src[\\/]/.test(testPath) && !/\bvi\.mock\(/.test(readFileSync(testPath, 'utf8'))) {
  await import('../packages/core/src/parts-all.ts')
  await import('../packages/core/src/part-canvas.ts')
}
