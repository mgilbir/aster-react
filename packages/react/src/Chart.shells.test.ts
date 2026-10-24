/**
 * Anti-drift guard 1: `<Chart>` and `<SvgChart>` stay thin shells over ONE implementation (ChartCore).
 *
 * A shell may do exactly one thing: render `<ChartCore>` with the capabilities it injects. Hooks, branches,
 * helpers or a second JSX tree in a shell are logic that the other shell would not have: the start of drift.
 * This is a source-level check, because the drift it prevents (a prop handled in one shell, forgotten in the
 * other) is invisible to types and to behavioural tests that run the same props through both.
 *
 * The second guard walks the VALUE import graph of `@aster/react/lite`: it must never reach the canvas renderer,
 * the hit index or the signal loop, nor the modules that import them. (The bundle-shaking gate re-checks the
 * same thing on a real bundle; this one names the offending import chain.)
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))
const read = (file: string): string => readFileSync(join(SRC, file), 'utf8')

export const SHELLS = ['Chart.tsx', 'SvgChart.tsx'] as const
/** The most code lines (comments and blanks excluded) a shell may have. */
export const MAX_SHELL_LINES = 14

const ALLOWED_VALUE_IMPORTS: Record<(typeof SHELLS)[number], string[]> = {
  'Chart.tsx': ['react', './ChartCore.js', './canvas-capability.js', './interaction-capability.js'],
  'SvgChart.tsx': ['react', './ChartCore.js'],
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** Everything wrong with a shell's source; empty when it is a thin shell. */
export function shellProblems(file: (typeof SHELLS)[number], source: string): string[] {
  const code = stripComments(source)
  const lines = code.split('\n').filter((l) => l.trim() !== '')
  const problems: string[] = []
  if (lines.length > MAX_SHELL_LINES) problems.push(`${lines.length} code lines (max ${MAX_SHELL_LINES})`)
  const hooks = code.match(/\b(?:React\.)?use[A-Z]\w*\s*\(/g)
  if (hooks) problems.push(`calls hooks: ${[...new Set(hooks)].join(', ')}`)
  const jsx = code.match(/(?<![\w$])<[A-Za-z][\w.]*/g) ?? []
  if (jsx.length !== 1 || jsx[0] !== '<ChartCore') problems.push(`must render exactly one <ChartCore> and nothing else (found ${jsx.join(' ') || 'none'})`)
  if ((code.match(/\breturn\b/g) ?? []).length !== 1) problems.push('must have exactly one return')
  if ((code.match(/=>|\bfunction\b/g) ?? []).length !== 1) problems.push('must define only the forwardRef render function (no helpers, no branches in closures)')
  if (/\b(?:if|else|switch|for|while|try)\b|\?\s|&&|\|\|/.test(code.replace(/\bimport\b[^\n]*/g, ''))) problems.push('has control flow')
  for (const m of code.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)) {
    if (!m[1] && !ALLOWED_VALUE_IMPORTS[file].includes(m[2]!)) problems.push(`imports ${m[2]} as a value (allowed: ${ALLOWED_VALUE_IMPORTS[file].join(', ')})`)
  }
  return problems
}

describe('<Chart> and <SvgChart> are thin shells over ChartCore', () => {
  it.each(SHELLS)('%s has no logic of its own', (file) => {
    expect(shellProblems(file, read(file))).toEqual([])
  })

  it('ChartCore is the only implementation: neither shell references the other or duplicates its work', () => {
    expect(stripComments(read('Chart.tsx'))).not.toMatch(/SvgChart/)
    expect(stripComments(read('SvgChart.tsx'))).not.toMatch(/\bChart\b/)
  })

  // The guard must reject real drift, or it proves nothing.
  describe('the guard bites', () => {
    const thin = read('SvgChart.tsx')
    it.each([
      ['a hook', thin.replace('return <ChartCore', 'const [n] = React.useState(0)\n  return <ChartCore data-n={n}')],
      ['a branch', thin.replace('return <ChartCore {...props} ref={ref} />', 'if (props.width) return <ChartCore {...props} ref={ref} />\n  return <ChartCore {...props} ref={ref} />')],
      ['a second element', thin.replace('return <ChartCore {...props} ref={ref} />', 'return <div><ChartCore {...props} ref={ref} /></div>')],
      ['a helper', thin.replace('export const SvgChart', 'const helper = (x: number) => x + 1\nexport const SvgChart')],
      ['a value import of the canvas capability', thin.replace("import { ChartCore }", "import { canvasCapability } from './canvas-capability.js'\nimport { ChartCore }")],
      ['bulk', thin + '\n' + Array.from({ length: 20 }, (_, i) => `export const x${i} = ${i}`).join('\n')],
    ])('rejects %s', (_what, source) => {
      expect(shellProblems('SvgChart.tsx', source).length).toBeGreaterThan(0)
    })
    it('accepts the real shells', () => {
      for (const f of SHELLS) expect(shellProblems(f, read(f))).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------

const FORBIDDEN_PACKAGES = ['@aster/core/canvas', '@aster/core/hit', '@aster/core/signals']
const FORBIDDEN_MODULES = ['canvas-capability.ts', 'interaction-capability.ts']

/** Value (non-`import type`) imports and re-exports of a source file. */
export function valueImports(source: string): string[] {
  const out: string[] = []
  for (const m of stripComments(source).matchAll(/^(?:import|export)\s+(type\s+)?(?:[^'"]*?from\s+)?'([^']+)'/gm)) {
    if (!m[1]) out.push(m[2]!)
  }
  return out
}

/** The first import chain from `entry` to a forbidden package or module, or null. */
export function chainToForbidden(entry: string, read: (file: string) => string): string[] | null {
  const seen = new Set<string>()
  const walk = (file: string, chain: string[]): string[] | null => {
    if (seen.has(file)) return null
    seen.add(file)
    for (const spec of valueImports(read(file))) {
      if (FORBIDDEN_PACKAGES.includes(spec)) return [...chain, file, spec]
      if (!spec.startsWith('.')) continue
      const target = spec.replace(/\.js$/, '.ts').replace(/^\.\//, '')
      const resolved = [target, target.replace(/\.ts$/, '.tsx')].find((t) => { try { read(t); return true } catch { return false } })
      if (!resolved) throw new Error(`cannot resolve ${spec} from ${file}`)
      if (FORBIDDEN_MODULES.includes(resolved.replace(/\.tsx$/, '.ts'))) return [...chain, file, resolved]
      const hit = walk(resolved, [...chain, file])
      if (hit) return hit
    }
    return null
  }
  return walk(entry, [])
}

describe('@aster/react/lite never reaches the canvas renderer, the hit index or the signal loop', () => {
  const fromSrc = (f: string): string => readFileSync(resolve(SRC, f), 'utf8')
  it('the value import graph of lite.ts is clean', () => {
    expect(chainToForbidden('lite.ts', fromSrc)).toBeNull()
  })
  it('the full entry does reach them (the walker finds the chain it is meant to forbid)', () => {
    expect(chainToForbidden('Chart.tsx', fromSrc)).not.toBeNull()
  })
  it('the guard bites: a value import of core/hit in ChartCore is reported with its chain', () => {
    const tampered = (f: string): string => (f === 'ChartCore.tsx' ? `import { buildHitIndex } from '@aster/core/hit'\n${fromSrc(f)}` : fromSrc(f))
    expect(chainToForbidden('lite.ts', tampered)).toEqual(['lite.ts', 'SvgChart.tsx', 'ChartCore.tsx', '@aster/core/hit'])
  })
})
