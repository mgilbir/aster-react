/**
 * docs/RUNBOOK.md section 3 says it lists "everything the repository's own code reads (`process.env`, found by searching every tracked
 * source file)". This makes the claim a check (C726): every environment read (dot or bracket form) of a tracked source file is named
 * in the section, and `NODE_ENV`, which the shipped code reads, is described as read, not as an esbuild define nothing reads.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runbook = readFileSync(join(root, 'docs', 'RUNBOOK.md'), 'utf8')
const section = runbook.slice(runbook.indexOf('## 3. Environment variables'))

/** Variables of the platform that no one sets for this repository; they are read, not configuration. */
const PLATFORM = new Set(['PATH', 'HOME', 'CI', 'GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY'])

function envVarsRead() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => /\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(f) && !f.startsWith('docs/audits/'))
  const found = new Map()
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8')
    for (const m of text.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g)) {
      const name = m[1] ?? m[2]
      if (!found.has(name)) found.set(name, new Set())
      found.get(name).add(f)
    }
  }
  return found
}

describe('docs/RUNBOOK.md lists the environment variables the repository reads', () => {
  const found = envVarsRead()

  it('finds the variables (guards the search itself)', () => {
    expect(found.size).toBeGreaterThan(30)
    expect(found.has('NODE_ENV') && found.has('TZ') && found.has('ASTER_CORPUS_DIR')).toBe(true)
  })

  it('names every variable a tracked source file reads', () => {
    const missing = [...found.keys()].filter((n) => !PLATFORM.has(n) && !new RegExp(`\\b${n}\\b`).test(section))
    expect(missing, `read by the code, absent from RUNBOOK section 3: ${missing.map((n) => `${n} (${[...found.get(n)].slice(0, 2).join(', ')})`).join('; ')}`).toEqual([])
  })

  it('does not claim NODE_ENV is only a define that nothing reads: shipped code reads it', () => {
    const shipped = [...(found.get('NODE_ENV') ?? [])].filter((f) => /^packages\/(core|react|vl)\/src\/[^/]+\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
    expect(shipped.length, 'shipped code that reads NODE_ENV').toBeGreaterThan(0)
    expect(section).not.toMatch(/nothing reads it/)
    expect(section).toMatch(/NODE_ENV[\s\S]{0,400}(read by|reads)/)
  })
})
