/**
 * Module-specifier extraction for the dependency-boundary check.
 *
 * Parses with the TypeScript compiler (a root devDependency) instead of regexes,
 * so every form TS and JS allow is seen, and comments/strings that merely look
 * like imports are not:
 *
 *   import x from 'a'            import 'a'                import type { T } from 'a'
 *   import x = require('a')      export * from 'a'         export { x } from 'a'
 *   import('a')                  import(`a`)               import('a' + '/b')
 *   require('a')                 require.resolve('a')      import.meta.resolve('a')
 *   importScripts('a')           type X = import('a').Y    /// <reference types="a" />
 *
 * Specifiers that cannot be resolved statically (a computed `import(name)`, a
 * template with a substitution before the package name, a bare `require`
 * reference, `createRequire`) are returned as `unanalyzable` so the caller can
 * fail loudly instead of letting them through.
 */
import ts from 'typescript'

const SCRIPT_KINDS = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
}

export const CODE_EXT = new Set(Object.keys(SCRIPT_KINDS))

/** Peel parentheses, `as`/`satisfies`/`!`/`<T>` wrappers off an expression. */
function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) node = node.expression
  return node
}

/**
 * Constant-fold a specifier expression. Returns
 *   { value }              fully static string,
 *   { prefix }             static head followed by something dynamic,
 *   null                   nothing static is known.
 */
function fold(node) {
  node = unwrap(node)
  if (ts.isStringLiteralLike(node)) return { value: node.text } // string + no-substitution template
  if (ts.isTemplateExpression(node)) {
    let prefix = node.head.text
    for (const span of node.templateSpans) {
      const inner = fold(span.expression)
      if (!inner || inner.value === undefined) return { prefix }
      prefix += inner.value + span.literal.text
    }
    return { value: prefix }
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = fold(node.left)
    if (!l) return null
    if (l.value === undefined) return l
    const r = fold(node.right)
    if (!r) return { prefix: l.value }
    return r.value !== undefined ? { value: l.value + r.value } : { prefix: l.value + r.prefix }
  }
  return null
}

/** `require`, `require.resolve`, `module.require`, `import.meta.resolve`, `importScripts`. */
function isLoaderCallee(expr) {
  expr = unwrap(expr)
  if (ts.isIdentifier(expr)) return expr.text === 'require' || expr.text === 'importScripts'
  if (ts.isPropertyAccessExpression(expr)) {
    const name = expr.name.text
    const obj = unwrap(expr.expression)
    if (name === 'require') return true // module.require, globalThis.require, ...
    if (name === 'resolve') {
      if (ts.isIdentifier(obj) && obj.text === 'require') return true
      if (ts.isMetaProperty(obj) && obj.keywordToken === ts.SyntaxKind.ImportKeyword) return true
    }
  }
  return false
}

/**
 * @returns {{ specs: string[], unanalyzable: { line: number, text: string }[] }}
 */
export function scanSource(text, fileName) {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  const kind = SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)
  const specs = []
  const unanalyzable = []

  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const flag = (n, why) => unanalyzable.push({ line: lineOf(n), text: `${why}: ${n.getText(sf).slice(0, 80)}` })

  function addExpr(node, call) {
    const f = fold(node)
    if (f && f.value !== undefined) { specs.push(f.value); return }
    // A dynamic tail is fine for relative/absolute specifiers; a dynamic head or
    // package-name part is not.
    const prefix = f?.prefix ?? ''
    if (prefix.startsWith('.') || prefix.startsWith('/')) return
    if (prefix && /^(@[^/]+\/)?[^/]+\//.test(prefix)) { specs.push(prefix); return } // package name fully known
    flag(call, 'non-static module specifier')
  }

  const handled = new Set()
  function markHandled(callee) {
    callee = unwrap(callee)
    if (ts.isIdentifier(callee)) handled.add(callee)
    else if (ts.isPropertyAccessExpression(callee)) {
      const obj = unwrap(callee.expression)
      if (ts.isIdentifier(obj)) handled.add(obj)
    }
  }
  /** `x.require`, `{ require: 1 }`, `interface { require }`: a name, not a reference. */
  function isNameOnly(id) {
    const p = id.parent
    if (!p) return false
    if (ts.isPropertyAccessExpression(p) && p.name === id) return true
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p)) && p.name === id) return true
    return false
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      addExpr(node.moduleSpecifier, node)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addExpr(node.moduleReference.expression, node)
    } else if (ts.isImportTypeNode(node)) {
      const lit = node.argument
      if (ts.isLiteralTypeNode(lit) && ts.isStringLiteralLike(lit.literal)) specs.push(lit.literal.text)
      else flag(node, 'non-static import type')
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword
      if (isImport || isLoaderCallee(callee)) {
        const arg = node.arguments[0]
        if (arg) addExpr(arg, node)
        else flag(node, 'loader call without specifier')
        markHandled(callee)
      }
    } else if (
      ts.isIdentifier(node) && (node.text === 'require' || node.text === 'createRequire') &&
      !handled.has(node) && !isNameOnly(node)
    ) {
      // `const r = require; r('vega')`, `createRequire(import.meta.url)`: the loader escapes analysis.
      flag(node, 'indirect module loader')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // /// <reference types="a" /> and /// <reference path>
  const pre = ts.preProcessFile(text, true, true)
  for (const ref of pre.typeReferenceDirectives) specs.push(ref.fileName)

  return { specs, unanalyzable }
}

/** Package name of an import specifier, or null for relative/absolute/builtin-protocol paths. */
export function packageName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  if (/^(node|data|file|http|https):/.test(spec)) return null
  const parts = spec.split('/')
  if (spec.startsWith('@')) return parts.length >= 2 ? parts.slice(0, 2).join('/') : spec
  return parts[0]
}

/**
 * The oracle stack: everything on the "own the engine" list. Matches the bare
 * package (`vega`, `d3`, `topojson`) and every hyphenated family member
 * (`vega-lite`, `vega-embed`, `d3-array`, `topojson-client`, ...). `@types/*`
 * stubs for them are type-only but still pull the oracle's surface into the
 * public types, so they are banned too.
 */
export const BANNED = /^(?:@types\/)?(?:vega|d3|topojson)(?:-|$)/

export function isBanned(name) {
  return BANNED.test(name)
}
