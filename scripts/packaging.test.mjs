/** Manifest consistency for the three published packages (C88). */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const PUBLIC = ['core', 'react', 'vl']

describe.each(PUBLIC)('@aster/%s manifest', (name) => {
  const pkg = JSON.parse(read(`packages/${name}/package.json`))

  it('keywords is an array of non-empty strings', () => {
    expect(Array.isArray(pkg.keywords)).toBe(true)
    expect(pkg.keywords.length).toBeGreaterThan(0)
    for (const k of pkg.keywords) expect(typeof k === 'string' && k.trim() === k && k.length > 0, String(k)).toBe(true)
  })

  it('every export entry uses the same conditions: types then default', () => {
    for (const [sub, target] of Object.entries(pkg.exports)) {
      if (sub === './package.json') continue
      expect(Object.keys(target), sub).toEqual(['types', 'default'])
      expect(target.types, sub).toMatch(/^\.\/dist\/.+\.d\.ts$/)
      expect(target.default, sub).toMatch(/^\.\/dist\/.+\.js$/)
    }
  })

  it('does not ship source maps (their ../src sources are not in the tarball)', () => {
    expect(pkg.files).toContain('!dist/**/*.map')
    if (name !== 'vl') {
      const build = JSON.parse(read(`packages/${name}/tsconfig.build.json`))
      expect(build.compilerOptions.sourceMap).toBeFalsy()
      expect(build.compilerOptions.declarationMap).toBeFalsy()
    }
  })
})

describe('pnpm-workspace.yaml', () => {
  const ws = read('pnpm-workspace.yaml')
  it('has no unresolved placeholder', () => {
    expect(ws).not.toMatch(/set this to|TODO|FIXME|placeholder/i)
  })
  it('decides every build-script permission explicitly with a boolean', () => {
    const block = ws.match(/^allowBuilds:\n((?:[ \t]+\S.*\n?)+)/m)?.[1] ?? ''
    expect(block.length).toBeGreaterThan(0)
    for (const line of block.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))) {
      expect(line, line).toMatch(/^\s+[\w@/.-]+:\s*(true|false)\s*$/)
    }
  })
})
