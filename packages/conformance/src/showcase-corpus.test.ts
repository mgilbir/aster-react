/**
 * The demo's showcase specs ARE corpus specs (C689): `apps/demo/src/showcase.tsx` imports each from `packages/conformance/corpus`,
 * where every gate compares it with real vega / vega-lite. A copy of a spec in the demo (it had fourteen; five were in no corpus and no
 * gate, the nine others were byte-identical copies nothing kept so) is a spec the gates do not see.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEMO = join(REPO, 'apps', 'demo', 'src')
const CORPUS = join(REPO, 'packages', 'conformance', 'corpus')
const source = readFileSync(join(DEMO, 'showcase.tsx'), 'utf8')
const imports = [...source.matchAll(/^import \w+ from '([^']+\.json)'$/gm)].map((m) => m[1]!)

describe('the demo showcase imports its specs from the corpus', () => {
  it('imports all fourteen, each from packages/conformance/corpus', () => {
    expect(imports.length).toBe(14)
    for (const path of imports) {
      expect(dirname(resolve(DEMO, path)), `${path} is not in the corpus`).toBe(CORPUS)
      expect(existsSync(resolve(DEMO, path)), `${path} does not exist`).toBe(true)
    }
    expect(new Set(imports).size).toBe(imports.length)
  })

  it('keeps no copy of a spec in the demo', () => {
    expect(existsSync(join(DEMO, 'showcase'))).toBe(false)
    expect(source).not.toMatch(/from '\.\/showcase\//)
  })

  it('every showcase spec is rendered by an element that uses it (none is imported and left)', () => {
    for (const path of imports) {
      const name = path.split('/').pop()!.replace(/\.(vl|vg)\.json$/, '')
      expect(imports.filter((p) => p.includes(name)).length).toBe(1)
    }
    // each import binding is used as a `raw` and an `aster` pane
    for (const m of source.matchAll(/^import (\w+) from '[^']+\.json'$/gm)) expect(source.match(new RegExp(`\\b${m[1]}\\b`, 'g'))!.length, m[1]).toBeGreaterThanOrEqual(3)
  })
})
