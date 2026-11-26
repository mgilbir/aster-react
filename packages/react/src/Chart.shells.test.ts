/**
 * Anti-drift guard 1: `<Chart>` and `<SvgChart>` stay thin shells over ONE implementation (ChartCore).
 *
 * A shell may do exactly one thing: render `<ChartCore>` with the capabilities it injects. Hooks, branches,
 * helpers or a second JSX tree in a shell are logic that the other shell would not have: the start of drift.
 * This is a source-level check, because the drift it prevents (a prop handled in one shell, forgotten in the
 * other) is invisible to types and to behavioural tests that run the same props through both.
 *
 * The second guard walks the VALUE import graph of `@aster-charts/react/lite`: it must never reach the canvas renderer,
 * the hit index or the signal loop, nor the modules that import them. (The bundle-shaking gate re-checks the
 * same thing on a real bundle; this one names the offending import chain.)
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))
const read = (file: string): string => readFileSync(join(SRC, file), 'utf8')

export const SHELLS = ['Chart.tsx', 'SvgChart.tsx'] as const

const ALLOWED_VALUE_IMPORTS: Record<(typeof SHELLS)[number], string[]> = {
  'Chart.tsx': ['react', './ChartCore.js', './canvas-capability.js', './interaction-capability.js', './png-capability.js'],
  'SvgChart.tsx': ['react', './ChartCore.js'],
}

/** The attributes a shell may put on `<ChartCore>` besides `{...props}` and `ref={ref}`: name -> the identifier it is given. */
const INJECTED: Record<(typeof SHELLS)[number], Record<string, string>> = {
  'Chart.tsx': { canvas: 'canvasCapability', interaction: 'interaction', png: 'png' },
  'SvgChart.tsx': {},
}

const parse = (file: string, source: string): ts.SourceFile => ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)

/** Strip parentheses and `as` / `satisfies` / non-null wrappers: `(x as T)!` is `x` for the purpose of "what is being returned". */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression
  return n
}

/**
 * Everything wrong with a shell's source; empty when it is a thin shell. Read from the syntax tree, so the quote style, spacing and
 * layout of the source decide nothing: a shell is
 *
 *   imports (value imports only from the allowed modules, in any form, side-effect imports included);
 *   export const Name = React.forwardRef<...>(function Name(props, ref) { return <ChartCore {...props} [injected={identifier}] ref={ref} /> })
 *
 * and nothing else. Any other attribute (a prop forced, dropped or defaulted in one shell only: `tooltip={undefined}`,
 * `a11y={props.a11y ?? false}`), any statement, hook, branch, helper or second element is the drift this guard exists to stop.
 */
export function shellProblems(file: (typeof SHELLS)[number], source: string): string[] {
  const sf = parse(file, source)
  const problems: string[] = []
  const allowed = ALLOWED_VALUE_IMPORTS[file]
  const injected = INJECTED[file]
  let exported = 0
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : st.moduleSpecifier.getText(sf)
      const typeOnly = st.importClause?.isTypeOnly === true
        || (st.importClause != null && st.importClause.name == null && st.importClause.namedBindings != null && ts.isNamedImports(st.importClause.namedBindings)
          && st.importClause.namedBindings.elements.length > 0 && st.importClause.namedBindings.elements.every((e) => e.isTypeOnly))
      if (!typeOnly && !allowed.includes(spec)) problems.push(`imports ${spec} as a value (allowed: ${allowed.join(', ')})`)
    } else if (ts.isExportDeclaration(st)) {
      if (!st.isTypeOnly) problems.push(`re-exports ${st.moduleSpecifier ? st.moduleSpecifier.getText(sf) : 'a binding'} as a value`)
    } else if (ts.isVariableStatement(st)) {
      exported++
      const decls = st.declarationList.declarations
      const init = decls.length === 1 ? decls[0]!.initializer : undefined
      const call = init ? unwrap(init) : undefined
      const callee = call && ts.isCallExpression(call) ? call.expression.getText(sf) : ''
      if (!call || !ts.isCallExpression(call) || (callee !== 'React.forwardRef' && callee !== 'forwardRef') || call.arguments.length !== 1) {
        problems.push('the shell must be one `React.forwardRef(render)` constant')
        continue
      }
      const render = unwrap(call.arguments[0]! as ts.Expression)
      if (!ts.isFunctionExpression(render) && !ts.isArrowFunction(render)) { problems.push('the forwardRef argument must be the render function'); continue }
      const params = render.parameters.map((p) => p.name.getText(sf))
      if (params.join(',') !== 'props,ref') problems.push(`the render function takes (props, ref), not (${params.join(', ')})`)
      const body = render.body
      let result: ts.Expression | undefined
      if (ts.isBlock(body)) {
        if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0]!)) problems.push('the render function must be exactly one return (no hooks, branches or helpers)')
        else result = (body.statements[0] as ts.ReturnStatement).expression
      } else result = body
      const element = result ? unwrap(result) : undefined
      if (!element || !ts.isJsxSelfClosingElement(element) || element.tagName.getText(sf) !== 'ChartCore') {
        problems.push('must render exactly one <ChartCore> and nothing else')
        continue
      }
      if (element.typeArguments?.length) problems.push('<ChartCore> takes no type arguments here')
      const attrs = element.attributes.properties
      const first = attrs[0]
      if (!first || !ts.isJsxSpreadAttribute(first) || first.expression.getText(sf) !== 'props') problems.push('the first attribute must be {...props}')
      const last = attrs[attrs.length - 1]
      if (!last || !ts.isJsxAttribute(last) || last.name.getText(sf) !== 'ref' || last.initializer?.getText(sf) !== '{ref}') problems.push('the last attribute must be ref={ref}')
      const seen = new Set<string>()
      for (const a of attrs.slice(1, -1)) {
        if (!ts.isJsxAttribute(a)) { problems.push(`unexpected attribute ${a.getText(sf)}`); continue }
        const name = a.name.getText(sf)
        const value = a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression ? a.initializer.expression.getText(sf) : a.initializer?.getText(sf)
        if (!(name in injected)) problems.push(`passes ${a.getText(sf)} (a prop handled in one shell only; this shell injects ${Object.keys(injected).join(', ') || 'nothing'})`)
        else if (value !== injected[name]) problems.push(`passes ${a.getText(sf)}, not ${name}={${injected[name]}}`)
        if (seen.has(name)) problems.push(`passes ${name} twice`)
        seen.add(name)
      }
      for (const name of Object.keys(injected)) if (!seen.has(name)) problems.push(`does not inject ${name}`)
    } else if (!ts.isTypeAliasDeclaration(st) && !ts.isInterfaceDeclaration(st)) {
      problems.push(`has a statement of its own: ${st.getText(sf).split('\n')[0]!.slice(0, 60)}`)
    }
  }
  if (exported !== 1) problems.push(`must declare exactly one component (found ${exported})`)
  return problems
}

/** Comments and string-free source for the cross-reference check below (the shells never mention each other in code). */
function stripComments(src: string): string {
  const sf = parse('x.tsx', src)
  const printer = ts.createPrinter({ removeComments: true })
  return printer.printFile(sf)
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
    const full = read('Chart.tsx')
    const render = 'return <ChartCore {...props} ref={ref} />'
    it.each([
      ['a hook', thin.replace('return <ChartCore', 'const [n] = React.useState(0)\n  return <ChartCore data-n={n}')],
      ['a branch', thin.replace(render, 'if (props.width) return <ChartCore {...props} ref={ref} />\n  return <ChartCore {...props} ref={ref} />')],
      ['a branch with no space after the `?`', thin.replace(render, 'return <ChartCore {...props} denseMarks={props.width!=null?false:props.denseMarks} ref={ref} />')],
      ['a second element', thin.replace(render, 'return <div><ChartCore {...props} ref={ref} /></div>')],
      ['a helper', thin.replace('export const SvgChart', 'const helper = (x: number) => x + 1\nexport const SvgChart')],
      ['a prop forced in one shell only', thin.replace(render, 'return <ChartCore {...props} tooltip={undefined} incremental={false} ref={ref} />')],
      ['a prop defaulted in one shell only', thin.replace(render, 'return <ChartCore {...props} a11y={props.a11y??false} ref={ref} />')],
      ['a prop placed before the spread (it would be overridden, and still drift)', thin.replace(render, 'return <ChartCore a11y={false} {...props} ref={ref} />')],
      ['a second spread', thin.replace(render, 'return <ChartCore {...props} {...{ a11y: false }} ref={ref} />')],
      ['a value import of the canvas capability', thin.replace("import { ChartCore }", "import { canvasCapability } from './canvas-capability.js'\nimport { ChartCore }")],
      ['a double-quoted value import of the canvas capability', thin.replace("import { ChartCore }", 'import { canvasCapability } from "./canvas-capability.js"\nimport { ChartCore }')],
      ['a side-effect import', thin.replace("import { ChartCore }", "import './interaction-capability.js'\nimport { ChartCore }")],
      ['a value re-export', thin + "\nexport * from './interaction-capability.js'\n"],
      ['bulk', thin + '\n' + Array.from({ length: 20 }, (_, i) => `export const x${i} = ${i}`).join('\n')],
    ])('rejects %s', (_what, source) => {
      expect(shellProblems('SvgChart.tsx', source), source).not.toEqual([])
    })
    it.each([
      ['a capability dropped', full.replace(' png={png}', '')],
      ['a capability given another value', full.replace('png={png}', 'png={undefined}')],
      ['an extra prop', full.replace('png={png}', 'png={png} tooltip={false}')],
    ])('rejects <Chart> with %s', (_what, source) => {
      expect(shellProblems('Chart.tsx', source), source).not.toEqual([])
    })
    it('accepts the real shells', () => {
      for (const f of SHELLS) expect(shellProblems(f, read(f))).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------

/** The core entries a lite chart must never reach: the canvas renderer, the hit index, the signal loop and the PNG painter. */
const FORBIDDEN_CORE_ENTRIES = new Set(['canvas', 'hit', 'signals', 'png'])
const FORBIDDEN_MODULES = ['canvas-capability.ts', 'interaction-capability.ts', 'png-capability.ts']

/**
 * Is `spec` one of the forbidden core entries, by any route: the entry itself, the lean engine's copy of it (`lean/hit`), or a path
 * into the package (`@aster-charts/core/dist/hit.js`, `.../src/signals`)? Matched by prefix, so a deeper path does not slip by.
 */
export function isForbiddenPackage(spec: string): boolean {
  const m = /^@aster-charts\/core\/(.+)$/.exec(spec)
  if (!m) return false
  const parts = m[1]!.split('/')
  while (parts[0] === 'lean' || parts[0] === 'dist' || parts[0] === 'src') parts.shift()
  const head = parts[0]?.replace(/\.(?:[cm]?[jt]s)$/, '')
  return head != null && FORBIDDEN_CORE_ENTRIES.has(head)
}

/**
 * Value (non-`import type`) imports and re-exports of a source file, its dynamic `import(...)`s and its `require(...)`s: a bundler
 * that does not split code puts what a dynamic import names in the bundle as surely as a static import. Read from the syntax
 * tree, so quote style, indentation, template literals and line layout decide nothing. A specifier that is not a literal cannot
 * be followed: it is returned as `<computed import: ...>` so the walk fails closed on it.
 */
export function valueImports(source: string): string[] {
  const out: string[] = []
  const sf = parse('x.tsx', source)
  const named = (e: ts.Expression | undefined): string => {
    if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text
    return `<computed import: ${e ? e.getText(sf) : 'none'}>`
  }
  const importIsTypeOnly = (d: ts.ImportDeclaration): boolean => {
    const c = d.importClause
    if (!c) return false
    if (c.isTypeOnly) return true
    const nb = c.namedBindings
    return c.name == null && nb != null && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) { if (!importIsTypeOnly(n)) out.push(named(n.moduleSpecifier)) }
    else if (ts.isExportDeclaration(n)) { if (n.moduleSpecifier && !n.isTypeOnly) out.push(named(n.moduleSpecifier)) }
    else if (ts.isImportEqualsDeclaration(n)) { if (!n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference)) out.push(named(n.moduleReference.expression)) }
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) out.push(named(n.arguments[0]))
    // (`typeof import('...')` in a type position is an ImportTypeNode, not a call: it is not a value import)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The first import chain from `entry` to a forbidden package or module, or null. */
export function chainToForbidden(entry: string, read: (file: string) => string): string[] | null {
  const seen = new Set<string>()
  const walk = (file: string, chain: string[]): string[] | null => {
    if (seen.has(file)) return null
    seen.add(file)
    for (const spec of valueImports(read(file))) {
      if (isForbiddenPackage(spec) || spec.startsWith('<computed import')) return [...chain, file, spec]
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

describe('@aster-charts/react/lite never reaches the canvas renderer, the hit index or the signal loop', () => {
  const fromSrc = (f: string): string => readFileSync(resolve(SRC, f), 'utf8')
  it('the value import graph of lite.ts is clean', () => {
    expect(chainToForbidden('lite.ts', fromSrc)).toBeNull()
  })
  it('the full entry does reach them (the walker finds the chain it is meant to forbid)', () => {
    expect(chainToForbidden('Chart.tsx', fromSrc)).not.toBeNull()
  })
  it('the guard bites: a value import of the lean hit index in ChartCore is reported with its chain', () => {
    const tampered = (f: string): string => (f === 'ChartCore.tsx' ? `import { buildHitIndex } from '@aster-charts/core/internal/hit'\n${fromSrc(f)}` : fromSrc(f))
    expect(chainToForbidden('lite.ts', tampered)).toEqual(['lite.ts', 'SvgChart.tsx', 'ChartCore.tsx', '@aster-charts/core/internal/hit'])
  })
  it('the guard bites: a value import of core/hit in ChartCore is reported with its chain', () => {
    const tampered = (f: string): string => (f === 'ChartCore.tsx' ? `import { buildHitIndex } from '@aster-charts/core/hit'\n${fromSrc(f)}` : fromSrc(f))
    expect(chainToForbidden('lite.ts', tampered)).toEqual(['lite.ts', 'SvgChart.tsx', 'ChartCore.tsx', '@aster-charts/core/hit'])
  })
  it('the guard bites: a dynamic import of the PNG painter in ChartCore is reported, a `typeof import()` type is not', () => {
    const dynamic = (f: string): string => (f === 'ChartCore.tsx' ? `${fromSrc(f)}\nexport const loadPng = () => import('@aster-charts/core/png')\n` : fromSrc(f))
    expect(chainToForbidden('lite.ts', dynamic)).toEqual(['lite.ts', 'SvgChart.tsx', 'ChartCore.tsx', '@aster-charts/core/png'])
    const typeOnly = (f: string): string => (f === 'ChartCore.tsx' ? `${fromSrc(f)}\nexport type PngModule = typeof import('@aster-charts/core/png')\n` : fromSrc(f))
    expect(chainToForbidden('lite.ts', typeOnly)).toBeNull()
  })
  describe('the guard reads the syntax, not a pattern of the text', () => {
    const tamper = (extra: string, prepend = false) => (f: string): string => (f === 'ChartCore.tsx' ? (prepend ? `${extra}\n${fromSrc(f)}` : `${fromSrc(f)}\n${extra}\n`) : fromSrc(f))
    it.each([
      ['a double-quoted import', 'import { buildHitIndex } from "@aster-charts/core/hit"', '@aster-charts/core/hit', true],
      ['an indented import', '  import { buildHitIndex } from \'@aster-charts/core/hit\'', '@aster-charts/core/hit', true],
      ['a dynamic import in double quotes', 'export const a = () => import("@aster-charts/core/png")', '@aster-charts/core/png', false],
      ['a dynamic import of a template literal', 'export const a = () => import(`@aster-charts/core/png`)', '@aster-charts/core/png', false],
      ['a require', 'export const a = () => require("@aster-charts/core/signals")', '@aster-charts/core/signals', false],
      ['a deep path into the package', "import { x } from '@aster-charts/core/dist/hit.js'", '@aster-charts/core/dist/hit.js', true],
      ['a re-export of a forbidden module', "export * from './interaction-capability.js'", 'interaction-capability.ts', false],
      ['a double-quoted import of a forbidden module', 'import { interaction } from "./interaction-capability.js"', 'interaction-capability.ts', true],
      ['a side-effect import', "import '@aster-charts/core/canvas'", '@aster-charts/core/canvas', true],
    ] as const)('reports %s', (_what, code, last, prepend) => {
      expect(chainToForbidden('lite.ts', tamper(code, prepend))?.at(-1)).toBe(last)
    })
    it('reports an import whose specifier is computed (it cannot be followed)', () => {
      const hit = chainToForbidden('lite.ts', tamper('export const a = (n: string) => import(`@aster-charts/core/${n}`)'))
      expect(hit?.at(-1)).toMatch(/^<computed import/)
    })
    it('does not report a type-only import or export, nor the lean engine itself', () => {
      expect(chainToForbidden('lite.ts', tamper("import type { HitIndex } from '@aster-charts/core/hit'\nimport { type A } from '@aster-charts/core/canvas'\nexport type { B } from '@aster-charts/core/signals'", true))).toBeNull()
      expect(isForbiddenPackage('@aster-charts/core/internal')).toBe(false)
      expect(isForbiddenPackage('@aster-charts/core')).toBe(false)
      expect(isForbiddenPackage('@aster-charts/core/internal/hit')).toBe(true)
    })
  })
})
