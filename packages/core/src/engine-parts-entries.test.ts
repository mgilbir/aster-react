// @vitest-environment node
/**
 * What the empty-slot error tells a host to do is true (C691). Every part of the engine names the entry that carries it
 * (`CARRIED_BY`); the claim is checked by importing that entry into a module registry that has nothing else, both ways: the named
 * entry fills the slot, and for a part that names none, neither public entry does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CARRIED_BY } from './engine-parts.js'
import type { EnginePart } from './engine-parts.js'

/** The slots an entry fills when it is imported into a registry of its own. */
async function loadedBy(entry: string): Promise<EnginePart[]> {
  vi.resetModules()
  const engine = await import('./engine-parts.js')
  await import(entry)
  return engine.ENGINE_PARTS.filter((p) => engine.partLoaded(p))
}
const FILE: Record<string, string> = { '@aster-charts/core': './index.js', '@aster-charts/core/signals': './entry-signals.js' }

describe('the empty-slot message names an entry that carries the part', () => {
  beforeEach(() => vi.resetModules())

  it('names a carrier for every part, or says there is none', async () => {
    const { ENGINE_PARTS } = await import('./engine-parts.js')
    expect(Object.keys(CARRIED_BY).sort()).toEqual([...ENGINE_PARTS].sort())
  })

  const byEntry = new Map<string, EnginePart[]>()
  for (const [name, entry] of Object.entries(CARRIED_BY)) {
    if (entry) byEntry.set(entry, [...(byEntry.get(entry) ?? []), name as EnginePart])
  }

  it.each([...byEntry])('importing %s fills every part that names it', async (entry, names) => {
    const loaded = await loadedBy(FILE[entry]!)
    expect(names.filter((n) => !loaded.includes(n))).toEqual([])
  })

  it('a part that names no entry is filled by neither public entry', async () => {
    const none = (Object.entries(CARRIED_BY) as Array<[EnginePart, string | null]>).filter(([, e]) => e === null).map(([n]) => n)
    expect(none.length).toBeGreaterThan(0)
    for (const file of Object.values(FILE)) expect((await loadedBy(file)).filter((p) => none.includes(p))).toEqual([])
  })

  it('the message of an empty slot is the one for its part', async () => {
    vi.resetModules()
    const { part, ENGINE_PARTS } = await import('./engine-parts.js')
    for (const name of ENGINE_PARTS) {
      let message = ''
      try { part(name) } catch (e) { message = (e as Error).message }
      expect(message, name).toContain(`the "${name}" part of the engine is not loaded`)
      const entry = CARRIED_BY[name]
      if (entry) expect(message, name).toContain(`import ${entry}, which carries it`)
      else expect(message, name).toContain('no entry of @aster-charts/core carries it')
    }
  })
})
