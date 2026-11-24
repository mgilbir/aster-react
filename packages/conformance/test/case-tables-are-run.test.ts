// @vitest-environment node
/**
 * A table of cases that no test reads is a set of specs that were meant to be compared and are not (C86: `ASTER_ONLY` sat in a cases
 * file for a reason that was false and was imported by nothing). Every constant a `*-cases.ts` or `*-space.ts` file exports must be
 * read somewhere in this directory other than where it is defined.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.mts'))
/** The code of a file: comments removed, so that a name that is only talked about is not a reader. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const text = new Map(files.map((f) => [f, code(readFileSync(join(dir, f), 'utf8'))] as const))

/** The names a source file exports as constants, functions or types of cases. */
export function exportedNames(source: string): string[] {
  return [...source.matchAll(/^export (?:const|function|async function) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!)
}
/** The files (other than `own`) in which `name` is read, plus its uses in its own file past the definition. */
export function readers(name: string, own: string, sources: ReadonlyMap<string, string>): string[] {
  const word = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')
  const out: string[] = []
  for (const [file, source] of sources) {
    const uses = [...source.matchAll(word)].length
    if (file === own ? uses > 1 : uses > 0) out.push(file)
  }
  return out
}

describe('every exported case table is read by a test', () => {
  const tables = files.filter((f) => /-(cases|space)\.m?ts$/.test(f))
  it('there are case files', () => expect(tables.length).toBeGreaterThan(8))
  for (const file of tables) {
    for (const name of exportedNames(text.get(file)!)) {
      it(`${file}: ${name}`, () => {
        expect(readers(name, file, text), `${name} is read by no test`).not.toEqual([])
      })
    }
  }
  it('sees an export nothing reads (planted)', () => {
    const planted = new Map([['a-cases.ts', 'export const UNUSED = []\n'], ['b.test.ts', "import { OTHER } from './a-cases.js'\n"]])
    expect(readers('UNUSED', 'a-cases.ts', planted)).toEqual([])
    expect(readers('OTHER', 'a-cases.ts', planted)).toEqual(['b.test.ts'])
  })
})
