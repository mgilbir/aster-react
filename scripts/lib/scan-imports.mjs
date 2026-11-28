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
 *   importScripts('a')           type X = import('a').Y    a triple-slash `types` directive
 *   new URL('a', import.meta.url)                          a triple-slash `path` directive
 *   declare module 'a' { }       a triple-slash `amd-dependency` directive
 *   m['require']('a')            globalThis['require']('a')
 *
 * Specifiers that cannot be resolved statically (a computed `import(name)`, a
 * template with a substitution before the package name) and every way of
 * reaching a loader without calling it on a literal (`const r = require`,
 * `x.require` read without a call, `createRequire` under any access path including
 * `m.createRequire` and `m['createRequire']`, `process.getBuiltinModule`, `eval`,
 * `new Function`) are returned as `unanalyzable` so the caller can fail loudly
 * instead of letting them through.
 *
 * `classifySpec` then sorts a specifier into what the boundary cares about: a banned package,
 * a URL or other non-package scheme (a browser library pulling Vega from a CDN), or a relative or
 * absolute path that leaves the package directory (into the oracle's node_modules).
 */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
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

/** The name an access reads: `x.name`, `x['name']` and ``x[`name`]`` all read `name`. */
function accessName(expr) {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(unwrap(expr.argumentExpression))) return unwrap(expr.argumentExpression).text
  return null
}

/** `require`, `require.resolve`, `module.require`, `globalThis['require']`, `import.meta.resolve`, `importScripts`. */
function isLoaderCallee(expr) {
  expr = unwrap(expr)
  if (ts.isIdentifier(expr)) return expr.text === 'require' || expr.text === 'importScripts'
  const name = accessName(expr)
  if (name === null) return false
  const obj = unwrap(expr.expression)
  if (name === 'require') return true // module.require, globalThis.require, globalThis['require'], ...
  if (name === 'resolve') {
    if (ts.isIdentifier(obj) && obj.text === 'require') return true
    if (ts.isMetaProperty(obj) && obj.keywordToken === ts.SyntaxKind.ImportKeyword) return true
  }
  return false
}

/** Names that hand out a module loader: reading one anywhere (not just calling it) lets a specifier escape analysis. */
const LOADER_NAMES = new Set(['require', 'createRequire', 'getBuiltinModule'])
/** Calls that compile source text, which can hold any import. */
const CODE_EVAL = new Set(['eval', 'Function'])

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

  // The identifiers of a loader call the scanner read the specifier of (`require`, `module.require`, `require.resolve`, `m['require']`).
  const handled = new Set()
  function markHandled(callee) {
    callee = unwrap(callee)
    if (ts.isIdentifier(callee)) handled.add(callee)
    else if (ts.isPropertyAccessExpression(callee)) {
      handled.add(callee.name)
      const obj = unwrap(callee.expression)
      if (ts.isIdentifier(obj)) handled.add(obj)
    } else if (ts.isElementAccessExpression(callee)) handled.add(callee)
  }
  /** `{ require: 1 }`, `interface { require }`, `class { require() {} }`: the name of a declaration, not a reference to a loader. */
  function isNameOnly(id) {
    const p = id.parent
    if (!p) return false
    return (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) || ts.isPropertyDeclaration(p)) && p.name === id
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
      ts.isIdentifier(node) && LOADER_NAMES.has(node.text) &&
      !handled.has(node) && !isNameOnly(node)
    ) {
      // `const r = require; r('vega')`, `createRequire(import.meta.url)`, `m.createRequire(...)('vega')`, `const r = m.require`:
      // the loader escapes analysis.
      flag(node, 'indirect module loader')
    }
    if (ts.isElementAccessExpression(node) && !handled.has(node)) {
      const n = accessName(node)
      if (n !== null && LOADER_NAMES.has(n)) flag(node, 'indirect module loader')
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const c = unwrap(node.expression)
      if (ts.isIdentifier(c) && CODE_EVAL.has(c.text)) flag(node, 'dynamic code evaluation')
      // `new URL('./x.js', import.meta.url)`: the module URL a worker or a dynamic import is handed.
      if (ts.isNewExpression(node) && ts.isIdentifier(c) && c.text === 'URL' && node.arguments?.length === 2) {
        const base = unwrap(node.arguments[1])
        if (ts.isPropertyAccessExpression(base) && ts.isMetaProperty(base.expression) && base.name.text === 'url') {
          const f = fold(node.arguments[0])
          if (f && f.value !== undefined) specs.push(f.value.startsWith('.') || /^[a-z][a-z0-9+.-]*:/i.test(f.value) || f.value.startsWith('/') ? f.value : `./${f.value}`)
        }
      }
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // `declare module 'vega' { ... }` in a shipped .d.ts pulls the oracle's surface into the public types.
      specs.push(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // the triple-slash directives: `types`, `path` and `amd-dependency`
  const pre = ts.preProcessFile(text, true, true)
  for (const ref of pre.typeReferenceDirectives) specs.push(ref.fileName)
  for (const ref of pre.referencedFiles) specs.push(/^(\.|\/|[a-z][a-z0-9+.-]*:)/i.test(ref.fileName) ? ref.fileName : `./${ref.fileName}`)
  for (const m of text.matchAll(/^[ \t]*\/\/\/[ \t]*<amd-dependency\s+path\s*=\s*["']([^"']+)["']/gm)) specs.push(m[1])

  return { specs, unanalyzable }
}

/** Package name of an import specifier, or null for relative/absolute paths and URLs (`node:` builtins and URL schemes). */
export function packageName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null
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

/**
 * What a specifier written in `file` (a path inside `packageDir`) is, for the boundary:
 *   { kind: 'banned', name }   a banned package (the caller applies its baseline);
 *   { kind: 'scheme', why }    a URL or other non-`node:` scheme (`https://esm.sh/vega`, `data:text/javascript,...`, `npm:vega`):
 *                              fetched at run time or resolved by the platform, so the check cannot see what it loads;
 *   { kind: 'escape', why }    a relative or absolute path that leaves `packageDir` or enters a `node_modules` (the oracle in
 *                              `../../conformance/node_modules/vega/...`);
 *   null                       anything else (a package that is not banned, a relative path inside the package).
 * A test file (`allowSiblings`) never ships and reads the sibling packages' built output by path, so leaving the package directory is
 * allowed for it; reaching into a `node_modules` (the oracle) is not.
 * @param {string} spec
 * @param {{ file: string, packageDir: string, allowSiblings?: boolean }} where absolute paths
 */
export function classifySpec(spec, { file, packageDir, allowSiblings = false }) {
  if (/^node:/i.test(spec)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    const npm = /^npm:\/*(@[^/@]+\/[^/@]+|[^/@]+)/i.exec(spec) // npm:<name>[@<range>][/<subpath>]
    if (npm && isBanned(npm[1])) return { kind: 'banned', name: npm[1] }
    return { kind: 'scheme', why: `"${spec.slice(0, 60)}" is not a package or a relative path` }
  }
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const target = resolve(dirname(file), spec)
    const rel = relative(packageDir, target)
    const outside = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
    // inside the package only the part below it counts; outside it, the whole path (the oracle is `<repo>/packages/conformance/node_modules/vega`)
    if ((outside ? target : rel).split(sep).includes('node_modules')) return { kind: 'escape', why: `"${spec}" reaches into node_modules` }
    if (!allowSiblings && outside) return { kind: 'escape', why: `"${spec}" leaves the package directory` }
    return null
  }
  const name = packageName(spec)
  return name && isBanned(name) ? { kind: 'banned', name } : null
}
