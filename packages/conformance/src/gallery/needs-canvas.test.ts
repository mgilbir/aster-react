/**
 * The static gallery path calls an oracle `unverifiable` (oracle-needs-canvas) when what vega logged says it wanted a canvas Node
 * does not have. It reads the logged stack, so it must read the message and the names on the stack, not where the code lives: in a
 * checkout whose path holds "canvas" (a worktree named after the canvas renderer) every oracle error used to be classified so, and
 * `vega/projections` (whose `airy` projection vega does not register, an ordinary oracle error both sides agree on) stopped passing.
 */
import { describe, it, expect } from 'vitest'
import * as vega from 'vega'
import { needsCanvas } from './lib.js'

/** What the collector logs for an error: its stack. */
async function loggedFor(spec: Record<string, unknown>): Promise<string[]> {
  const logged: string[] = []
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
  view.logger({ level() { return 1 }, error(...a: unknown[]) { logged.push(a.map((x) => (x as Error)?.stack ?? String(x)).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this } } as never)
  try { await view.runAsync() } catch (e) { logged.push((e as Error).stack ?? String(e)) }
  view.finalize()
  return logged
}
/** The same text as if the code lived under a directory called `canvas` (paths, `file:` urls, Windows paths). */
const movedUnderCanvas = (stack: string): string => stack
  .replace(/\(\/[^)]*?node_modules/g, '(/home/u/work/stack-5-canvas/node_modules')
  .replace(/at \/[^\s]*?node_modules/g, 'at /home/u/canvas-lane/node_modules')

describe('needsCanvas: a canvas Node lacks, not a path that says canvas', () => {
  it('an oracle error whose stack runs through a checkout named after the canvas renderer is an ordinary oracle error', async () => {
    const logged = await loggedFor({ projections: [{ name: 'p', type: 'airy' }] })
    expect(logged.some((m) => /Unrecognized projection type: airy/.test(m))).toBe(true)
    for (const m of logged) {
      const moved = movedUnderCanvas(m)
      expect(moved).toMatch(/canvas/)
      expect(needsCanvas(moved)).toBe(false)
      expect(needsCanvas(m.replace(/\(\/[^)]*\)/g, '(C:\\canvas\\vega.js:1:1)'))).toBe(false)
      expect(needsCanvas(m.replace(/\(\/[^)]*\)/g, '(file:///srv/canvas/vega.js:1:1)'))).toBe(false)
    }
  })

  it('what a missing canvas logs is still recognised, wherever the code lives', () => {
    const frames = '\n    at Object.getContext (/home/u/canvas-lane/node_modules/vega-canvas/build/index.js:3:9)\n    at resize (/srv/x/vega-scenegraph/src/util/canvas/resize.js:9:27)'
    expect(needsCanvas("TypeError: Cannot read properties of null (reading 'getContext')")).toBe(true)
    expect(needsCanvas(`TypeError: Cannot set properties of null (setting 'height')${frames}`)).toBe(true)
    expect(needsCanvas('Error: canvas is not supported in this environment')).toBe(true)
    expect(needsCanvas(`TypeError: Cannot set properties of null (setting 'height')\n    at /srv/canvas/anonymous.js:1:1`)).toBe(false)
  })
})
