/**
 * Anti-drift guard 2: no component test renders <Chart> outside the variant matrix.
 *
 * A test that imports `Chart` and renders it checks one variant only; the same assertion on `<SvgChart>` is then
 * either missing or copied (and the copy drifts). So every test file under packages/react/src that renders
 * `<Chart>` must go through `forEachVariant` (testing/variants.tsx), which hands the test its component and runs it on
 * every variant that has the capabilities the test declares. The exceptions are listed here, each with a reason;
 * a stale entry fails too.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))

/** Test files allowed to use `<Chart>` directly, and why. */
export const DIRECT_CHART_TESTS: Readonly<Record<string, string>> = {
  'Chart.corpus-parity.test.tsx': 'the differential itself: renders <Chart> and <SvgChart> side by side over the corpus and compares their DOM',
}

/** Value names that are the chart components. A test may use them only as the variant matrix hands them over. */
const CHART_NAMES: ReadonlySet<string> = new Set(['Chart', 'ChartCore'])
/** Modules whose import is "the chart": a dynamic or static value import of one is a use, whatever it is bound to. */
const CHART_MODULES = /^(?:\.{1,2}\/)*(?:Chart|ChartCore|index)(?:\.js|\.tsx?)?$|^@aster-charts\/react$/

/** One in-memory file: enough of a program for the type checker's symbol table (no libs, no module resolution). */
function symbols(source: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const name = '/x.test.tsx'
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, skipLibCheck: true, types: [] }
  const host = ts.createCompilerHost(options)
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (f, ...rest) => (f === name ? sf : f.endsWith('.d.ts') ? undefined : getSourceFile(f, ...rest))
  host.fileExists = (f) => f === name
  host.readFile = (f) => (f === name ? source : undefined)
  const program = ts.createProgram({ rootNames: [name], options, host })
  return { sf: program.getSourceFile(name)!, checker: program.getTypeChecker() }
}

/** Is `decl` the first parameter of the callback a `forEachVariant(needs, callback)` call hands the variant's component to? */
function isMatrixParameter(decl: ts.Declaration): boolean {
  if (!ts.isParameter(decl)) return false
  const fn = decl.parent
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false
  if (fn.parameters[0] !== decl) return false
  const call = fn.parent
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'forEachVariant' && call.arguments[1] === fn
}

/**
 * How a test source uses the chart component outside the variant matrix, read from the syntax tree and the file's own symbols:
 * `Chart` / `ChartCore` is the matrix's only inside the `forEachVariant` callback that is handed it, and nowhere else. Flagged:
 *   - a value import of the component (any quote style, renamed or not, namespace or named), static or dynamic, or `require`;
 *   - a binding of the name that is not the callback's parameter (a local probe that shadows the variant, a destructured
 *     `const { Chart } = await import(...)`), and any use of a name that does not resolve to the callback's parameter;
 *   - `<ChartCore>` and `X.Chart` / `X.ChartCore` anywhere.
 * Comments and strings are not code and are never flagged.
 */
export function directChartUse(source: string): string[] {
  const { sf, checker } = symbols(source)
  const uses = new Set<string>()
  const importsChartModule = (spec: ts.Expression | undefined): boolean => !!spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec)) && CHART_MODULES.test(spec.text)
  const isMatrixName = (id: ts.Identifier): boolean => {
    const sym = checker.getSymbolAtLocation(id)
    return !!sym?.declarations?.length && sym.declarations.every(isMatrixParameter)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && importsChartModule(n.moduleSpecifier)) {
      const c = n.importClause
      const typeOnly = c?.isTypeOnly === true
      if (!typeOnly) {
        if (!c) uses.add('imports the chart module for its effects')
        else if (c.name) uses.add('imports the chart module (default binding)')
        else if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) uses.add('imports the chart module as a namespace')
        else if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const e of c.namedBindings.elements) {
            if (e.isTypeOnly) continue
            if (CHART_NAMES.has((e.propertyName ?? e.name).text) || CHART_NAMES.has(e.name.text)) uses.add(`imports the ${(e.propertyName ?? e.name).text} value`)
          }
        }
      }
    }
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && importsChartModule(n.arguments[0])) {
      uses.add('imports the chart module dynamically')
    }
    if (ts.isBindingElement(n) && (CHART_NAMES.has(n.name.getText(sf)) || (n.propertyName && CHART_NAMES.has(n.propertyName.getText(sf))))) uses.add('binds the Chart value by destructuring')
    if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && ts.isIdentifier(n.name) && CHART_NAMES.has(n.name.text)) uses.add(`declares its own ${n.name.text} (it would shadow the variant)`)
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && CHART_NAMES.has(n.name.text) && !isMatrixParameter(n)) uses.add(`takes a ${n.name.text} parameter outside the forEachVariant callback`)
    if (ts.isPropertyAccessExpression(n) && CHART_NAMES.has(n.name.text)) uses.add(`reads .${n.name.text} off a module`)
    // JSX tag, createElement argument or any other value use of the name
    if (ts.isIdentifier(n) && CHART_NAMES.has(n.text) && isValuePosition(n) && !isMatrixName(n)) {
      uses.add(n.text === 'ChartCore' ? 'renders <ChartCore>' : 'renders Chart outside the variant matrix')
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...uses]
}

/** An identifier that names a value here (not a property name, a declaration's own name, an import clause or a type). */
function isValuePosition(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false
  if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || ts.isExpressionWithTypeArguments(p)) return false
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (ts.isPropertyAssignment(p) && p.name === id) return false
  if ((ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) || ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) return false
  return true
}

/** Files that use <Chart> directly without going through the matrix and without a listed reason. */
export function unmatrixed(files: Record<string, string>, allow: Readonly<Record<string, string>>): string[] {
  const out: string[] = []
  for (const [name, source] of Object.entries(files)) {
    if (name in allow) continue
    const uses = directChartUse(source)
    if (uses.length === 0) continue
    out.push(`${name}: ${uses.join('; ')}`)
  }
  return out
}

function testFiles(dir = SRC, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) Object.assign(out, testFiles(join(dir, e.name), `${prefix}${e.name}/`))
    else if (/\.test\.tsx?$/.test(e.name)) out[prefix + e.name] = readFileSync(join(dir, e.name), 'utf8')
  }
  return out
}

describe('every <Chart> component test goes through the variant matrix', () => {
  const files = testFiles()

  it('no test file renders <Chart> directly unless it is listed with a reason', () => {
    expect(unmatrixed(files, DIRECT_CHART_TESTS)).toEqual([])
  })

  it('every exception is still needed and has a reason', () => {
    for (const [name, reason] of Object.entries(DIRECT_CHART_TESTS)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20)
      expect(files[name], `${name} is listed but does not exist`).toBeDefined()
      expect(directChartUse(files[name]!).length, `${name} no longer renders <Chart> directly: remove it from DIRECT_CHART_TESTS`).toBeGreaterThan(0)
    }
  })

  it('the matrix really covers the suite: many files, all three variants named', () => {
    const matrixFiles = Object.entries(files).filter(([n, s]) => n !== 'Chart.matrix.test.ts' && /forEachVariant\(/.test(s))
    expect(matrixFiles.length).toBeGreaterThanOrEqual(20)
  })

  describe('the guard bites', () => {
    const VARIANT = "import { forEachVariant } from './testing/variants'\n"
    it.each([
      ['a JSX render', "import { Chart } from './Chart'\nrender(<Chart spec={s} />)"],
      ['a self-closing-less render', 'render(<Chart\n spec={s}\n/>)'],
      ['createElement', 'React.createElement(Chart, { spec })'],
      ['only the import', "import { Chart, type ChartHandle } from './Chart.js'\nconst x = 1"],
      ['a double-quoted import', 'import { Chart } from "./Chart"\nconst x = 1'],
      ['an import under another name', "import { Chart as C } from './index'\nrender(<C spec={s} />)"],
      ['a dynamic import and destructuring (a streaming test outside the matrix)', "it('x', async () => { const { Chart } = await import('./Chart'); render(<Chart />) })"],
      ['a dynamic import read off the module', "it('x', async () => { const m = await import('./Chart'); render(React.createElement(m.Chart)) })"],
      ['a namespace import', "import * as C from './Chart'\nconst x = 1"],
      ['the package entry', "import { Chart } from '@aster-charts/react'\nconst x = 1"],
      ['ChartCore rendered directly', "import { ChartCore } from './ChartCore'\nrender(<ChartCore spec={s} />)"],
      ['ChartCore rendered inside a matrix file', VARIANT + "import { ChartCore } from './ChartCore'\nforEachVariant(['svg'], () => { render(<ChartCore spec={s} />) })"],
      ['a matrix file that also imports the Chart value (it would shadow the variant)', VARIANT + "import { Chart } from './Chart'\nforEachVariant(['svg'], (Chart) => { render(<Chart />) })"],
      ['a local component named Chart that shadows the variant', VARIANT + "forEachVariant(['svg'], (Chart) => { it('x', () => { function Chart() { return null }\nrender(<Chart />) }) })"],
      ['a Chart used after the callback, where the variant is out of scope', VARIANT + "forEachVariant(['svg'], (Chart) => { it('x', () => {}) })\nrender(<Chart />)"],
      ['a second callback parameter named Chart (it is not the variant)', VARIANT + "forEachVariant(['svg'], (Other, Chart) => { render(<Chart />) })"],
      ['a render in a function that is not the forEachVariant callback', VARIANT + "const make = (Chart) => <Chart />\nforEachVariant(['svg'], () => {})"],
    ])('flags %s', (_what, source) => {
      expect(unmatrixed({ 'x.test.tsx': source }, {})).toHaveLength(1)
    })
    it.each([
      ['the matrix form', VARIANT + "forEachVariant(['svg'], (Chart) => { render(<Chart spec={s} />) })"],
      ['the matrix form with createElement and a nested callback', VARIANT + "forEachVariant(['svg'], (Chart, variant) => { describe('x', () => { it('y', () => { render(React.createElement(Chart, { spec })); render(<Chart />) }) }) })"],
      ['a function-expression callback', VARIANT + "forEachVariant(['svg'], function (Chart) { render(<Chart />) })"],
      ['a type-only import', "import type { ChartHandle } from './Chart'\nconst ref = createRef<ChartHandle>()"],
      ['an inline type-only specifier', "import { type ChartHandle, type ChartProps } from './Chart'\nconst x = 1"],
      ['a mention in a comment', '// renders <Chart> elsewhere\nconst x = 1'],
      ['a mention in a string', "it('renders <Chart> and <ChartCore> and import(\"./Chart\")', () => {})"],
      ['ChartStream', "import { ChartStream } from './ChartStream'\nrender(<ChartStream spec={s} />)"],
      ['SvgChart is not Chart', "import { SvgChart } from './SvgChart'\nrender(<SvgChart spec={s} />)"],
    ])('does not flag %s', (_what, source) => {
      expect(unmatrixed({ 'x.test.tsx': source }, {})).toEqual([])
    })
    it('honours an allow-list entry', () => {
      expect(unmatrixed({ 'x.test.tsx': 'render(<Chart />)' }, { 'x.test.tsx': 'a documented reason that is long enough' })).toEqual([])
    })
  })
})
