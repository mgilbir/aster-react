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
import { SVG_CHART_INTERACTION_PROPS, SVG_CHART_SHARED_HANDLE, SVG_CHART_SHARED_PROPS } from './svg-chart-types.js'
import { describe, it, expect } from 'vitest'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')

function compile(rootFiles: string[], paths?: Record<string, string[]>): ts.Diagnostic[] {
  const cfgPath = join(PKG, 'tsconfig.json')
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, PKG)
  const program = ts.createProgram({
    rootNames: rootFiles.map((f) => (f.startsWith('src/') ? join(PKG, f) : join(PKG, 'type-fixtures', f))),
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

  it('names every shared prop, every interaction prop, `png`, and calls every handle method (the fixture cannot fall behind the lists)', () => {
    const file = join(PKG, 'type-fixtures', 'svg-chart-accepts.fixture.tsx')
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
    const passed = new Set<string>()
    const used = new Set<string>()
    const visit = (n: ts.Node): void => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(source) === 'SvgChart') {
        for (const a of n.attributes.properties) if (ts.isJsxAttribute(a)) passed.add(a.name.getText(source))
      }
      if (ts.isPropertyAccessExpression(n)) used.add(n.name.text)
      ts.forEachChild(n, visit)
    }
    visit(source)
    const wantProps = [...SVG_CHART_SHARED_PROPS, ...SVG_CHART_INTERACTION_PROPS, 'interaction', 'png', 'ref']
    expect(wantProps.filter((p) => !passed.has(p)), 'props <SvgChart> has that the fixture never passes').toEqual([])
    expect([...passed].filter((p) => !wantProps.includes(p as never)), 'props the fixture passes that <SvgChart> does not list').toEqual([])
    expect(SVG_CHART_SHARED_HANDLE.filter((m) => !used.has(m)), 'handle members the fixture never touches').toEqual([])
  })

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
    // (the module itself is the root: the accepts fixture does not import it, so a program of the fixture alone never contains it)
    expect(compile(['src/parity.assert.ts']).map(where)).toEqual([])
  }, 120_000)

  // Each fixture augments the interface with one member nobody decided about: the program (the fixture and the assertion module it
  // imports) must then fail on EXACTLY the assertion of that list, and nowhere else. Were parity.assert.ts already broken somewhere
  // on its own, the plain program above would fail; were the fixture not to import it, nothing here would.
  it.each([
    ['bite-props.fixture.ts', 'PropsDecided', 'a prop added to ChartProps'],
    ['bite-handle.fixture.ts', 'HandleDecided', 'a method added to ChartHandle'],
  ])('%s: %s fails when %s has no decision for <SvgChart>', (fixture, assertion) => {
    const diags = compile([fixture])
    const src = readFileSync(join(PKG, 'src', 'parity.assert.ts'), 'utf8').split('\n')
    const lines = diags.map((d) => (d.file?.fileName.endsWith('parity.assert.ts') ? src[d.file.getLineAndCharacterOfPosition(d.start!).line]! : `elsewhere: ${where(d)}`))
    expect(lines, diags.map(where).join('\n')).toHaveLength(1)
    expect(lines[0]).toContain(`type ${assertion} `)
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
    '@aster-charts/react/lite': ['src/lite.ts'],
    '@aster-charts/react/interaction': ['src/interaction-capability.ts'],
    '@aster-charts/react': ['src/index.ts'],
  }
  it.each(examples)('%s is in %s verbatim', (fixture, doc) => {
    const code = readFileSync(join(PKG, 'type-fixtures', fixture), 'utf8')
    expect(readFileSync(doc, 'utf8').includes(code)).toBe(true)
  })
  it('compile (the `@ts-expect-error` line in the second must really be an error)', () => {
    expect(compile(examples.map(([f]) => f), paths).map(where)).toEqual([])
  }, 120_000)
})
