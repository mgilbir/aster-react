// @vitest-environment node
/**
 * The attack harness leaves nothing in the OS temp dir: its child's bundle is written into a directory the parent makes and removes
 * once the child is gone, whichever way the child (or the bundling) ended. ~2,450 directories of 23 MB each were once left by it.
 * Each case points TMPDIR at a fresh directory and requires it empty afterwards.
 */
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from '../../../scripts/lib/temp-dir.mjs'
import { attack } from './attack.testkit.js'

const root = makeTempDir('aster-attack-guard-')
afterAll(() => removeTempDir(root))
let n = 0

/** Run `fn` with TMPDIR (the OS temp dir) pointed at a fresh directory; return what is left in it afterwards. */
async function leftBehind(fn: () => Promise<unknown>): Promise<string[]> {
  const box = join(root, `tmp${n++}`)
  mkdirSync(box)
  const old = process.env.TMPDIR
  process.env.TMPDIR = box
  try { await fn() } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old }
  return readdirSync(box)
}

describe('attack() leaves no temp directory', () => {
  it('when the body returns', async () => {
    expect(await leftBehind(async () => { expect((await attack('return 1 + 1')).value).toBe(2) })).toEqual([])
  }, 60_000)

  it('when the body throws', async () => {
    expect(await leftBehind(async () => { expect((await attack('throw new Error("nope")')).threw?.message).toBe('nope') })).toEqual([])
  }, 60_000)

  it('when the child is killed before it reports (a SIGKILL from outside, as the hard kill does)', async () => {
    expect(await leftBehind(async () => {
      const r = await attack('process.kill(process.pid, "SIGKILL"); await new Promise(() => {})')
      expect(r.signal).toBe('SIGKILL')
      expect(r.reported).toBe(false)
    })).toEqual([])
  }, 60_000)

  it('when the bundle cannot be built (a body that is not JavaScript)', async () => {
    expect(await leftBehind(async () => { await expect(attack('this is not ) javascript')).rejects.toThrow() })).toEqual([])
  }, 60_000)
})
