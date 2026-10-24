/**
 * The type-level contract of `<SvgChart>`, run as a test: fixtures are compiled with the TypeScript API.
 *  - `svg-chart-accepts` must compile with no diagnostics;
 *  - `svg-chart-rejects` must fail on exactly the lines marked `@error`, no more and no fewer;
 *  - adding a prop to ChartProps / a method to ChartHandle without deciding about <SvgChart> must fail
 *    `parity.assert.ts` (the module `pnpm typecheck` checks), proven by augmenting the interfaces in a fixture.
 * The fixtures live outside `src` so `pnpm typecheck` does not see their deliberate errors.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')

function compile(rootFiles: string[], paths?: Record<string, string[]>): ts.Diagnostic[] {
  const cfgPath = join(PKG, 'tsconfig.json')
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, PKG)
  const program = ts.createProgram({
    rootNames: rootFiles.map((f) => join(PKG, 'type-fixtures', f)),
    options: { ...parsed.options, noEmit: true, ...(paths ? { baseUrl: PKG, paths } : {}) },
  })
  return ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error)
}

const where = (d: ts.Diagnostic): string => {
  if (!d.file || d.start == null) return String(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  const { line } = d.file.getLineAndCharacterOfPosition(d.start)
  return `${relative(PKG, d.file.fileName)}:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0]}`
}

describe('<SvgChart> prop typing', () => {
  it('accepts every prop that does not need interaction, and every prop with it', () => {
    const diags = compile(['svg-chart-accepts.fixture.tsx'])
    expect(diags.map(where)).toEqual([])
  }, 120_000)

  it('rejects interaction props without `interaction`, the canvas renderer and malformed capabilities, on exactly the marked lines', () => {
    const file = 'svg-chart-rejects.fixture.tsx'
    const diags = compile([file])
    const lines = readFileSync(join(PKG, 'type-fixtures', file), 'utf8').split('\n')
    const marked = lines.flatMap((l, i) => (l.trim() === '// @error' ? [i + 2] : [])) // 1-based line after the marker
    const got = diags.map((d) => {
      expect(d.file?.fileName.endsWith(file), where(d)).toBe(true)
      return d.file!.getLineAndCharacterOfPosition(d.start!).line + 1
    })
    expect([...new Set(got)].sort((a, b) => a - b), diags.map(where).join('\n')).toEqual(marked)
    expect(marked.length).toBeGreaterThanOrEqual(12)
  }, 120_000)
})

describe('<Chart> / <SvgChart> parity is enforced by the compiler', () => {
  it('parity.assert.ts compiles as it stands', () => {
    expect(compile(['svg-chart-accepts.fixture.tsx']).filter((d) => d.file?.fileName.endsWith('parity.assert.ts')).map(where)).toEqual([])
  }, 120_000)

  it.each([
    ['bite-props.fixture.ts', 'PropsDecided', 'a prop added to ChartProps'],
    ['bite-handle.fixture.ts', 'HandleDecided', 'a method added to ChartHandle'],
  ])('%s: %s fails when %s has no decision for <SvgChart>', (fixture, assertion) => {
    const diags = compile([fixture])
    const src = readFileSync(join(PKG, 'src', 'parity.assert.ts'), 'utf8').split('\n')
    const failing = diags
      .filter((d) => d.file?.fileName.endsWith('parity.assert.ts'))
      .map((d) => src[d.file!.getLineAndCharacterOfPosition(d.start!).line]!)
    expect(failing.some((l) => l.includes(`type ${assertion} `)), diags.map(where).join('\n')).toBe(true)
  }, 120_000)
})

// The documentation's own examples: each fixture under type-fixtures/docs is a code block of the docs, verbatim.
// It must still be in the document, and it must compile against the source (the package specifiers are mapped to it).
describe('the documented <SvgChart> examples compile', () => {
  const REPO = join(PKG, '..', '..')
  const examples: Array<[string, string]> = [
    ['docs/api-svgchart-1.tsx', join(REPO, 'docs', 'API.md')],
    ['docs/api-svgchart-2.tsx', join(REPO, 'docs', 'API.md')],
    ['docs/readme-lite.tsx', join(PKG, 'README.md')],
  ]
  const paths = {
    '@aster/react/lite': ['src/lite.ts'],
    '@aster/react/interaction': ['src/interaction-capability.ts'],
    '@aster/react': ['src/index.ts'],
  }
  it.each(examples)('%s is in %s verbatim', (fixture, doc) => {
    const code = readFileSync(join(PKG, 'type-fixtures', fixture), 'utf8')
    expect(readFileSync(doc, 'utf8').includes(code)).toBe(true)
  })
  it('compile (the `@ts-expect-error` line in the second must really be an error)', () => {
    expect(compile(examples.map(([f]) => f), paths).map(where)).toEqual([])
  }, 120_000)
})
