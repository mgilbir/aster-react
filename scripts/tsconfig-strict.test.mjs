/** The strict flags every package inherits stay on (C568): a package config may add flags, never turn these off. */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const FLAGS = ['strict', 'noUncheckedIndexedAccess', 'noImplicitOverride', 'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noUnusedParameters']
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

describe('tsconfig strictness', () => {
  it('the base config enables every strict flag', () => {
    const base = read(join(repo, 'tsconfig.base.json')).compilerOptions
    for (const f of FLAGS) expect(base[f], f).toBe(true)
  })
  it('the demo app, which has no base to extend, enables the three added flags itself', () => {
    const opts = read(join(repo, 'apps', 'demo', 'tsconfig.json')).compilerOptions
    for (const f of ['noImplicitReturns', 'noFallthroughCasesInSwitch', 'noUnusedParameters']) expect(opts[f], f).toBe(true)
  })
  it('no package or app config switches one off', () => {
    const dirs = [...readdirSync(join(repo, 'packages')).map((d) => join(repo, 'packages', d)), ...readdirSync(join(repo, 'apps')).map((d) => join(repo, 'apps', d))]
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((n) => /^tsconfig.*\.json$/.test(n))) {
        const opts = read(join(dir, name)).compilerOptions ?? {}
        for (const f of FLAGS) expect(opts[f], `${dir}/${name} ${f}`).not.toBe(false)
      }
    }
  })
})
