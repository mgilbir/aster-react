/**
 * "CSP-safe: no `new Function`, no `eval`" (README, docs/ARCHITECTURE.md) as a check on what ships (C18):
 *
 * - statically: every module of the built packages (`core`, `vl`, `react` dist) is parsed and searched for the constructors of code
 *   from strings: `new Function(...)` / `Function(...)`, `eval(...)` (direct or as a member), `setTimeout` / `setInterval` given a
 *   string, and the `Function` reached through `.constructor` of a function literal;
 * - dynamically: the whole corpus is rendered through the built packages in a process that refuses code generation from strings
 *   (`--disallow-code-generation-from-strings`, what a Content-Security-Policy without 'unsafe-eval' does), so a call the static
 *   search cannot see (a spec key that reaches `Function` by name, as C18 did) fails here too.
 * The static search is shown to find each shape it looks for on planted code, so a search that finds nothing has looked.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 300_000 })

const here = dirname(fileURLToPath(import.meta.url))
const packages = join(here, '..', '..')

/** The places in `source` that make code from a string, as `line: text`. */
function dynamicCodeSites(source: string, file = 'module.js'): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const found: string[] = []
  const at = (node: ts.Node, what: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    found.push(`${file}:${line + 1}: ${what}: ${node.getText(sf).slice(0, 80)}`)
  }
  const calleeName = (e: ts.Expression): string | undefined =>
    ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : undefined
  const isStringy = (e: ts.Expression | undefined): boolean =>
    !!e && (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && (isStringy(e.left) || isStringy(e.right))))
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      if (name === 'Function' || name === 'AsyncFunction' || name === 'GeneratorFunction') at(node, 'Function constructor')
      if (ts.isCallExpression(node) && name === 'eval') at(node, 'eval')
      if (ts.isCallExpression(node) && (name === 'setTimeout' || name === 'setInterval') && isStringy(node.arguments[0])) at(node, `${name} with a string`)
      // (`(function(){}).constructor('...')`, `(() => 0).constructor(...)`: Function by another name)
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'constructor') {
        let target: ts.Expression = callee.expression
        while (ts.isParenthesizedExpression(target)) target = target.expression
        if (ts.isFunctionExpression(target) || ts.isArrowFunction(target)) at(node, 'Function through .constructor')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function jsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...jsFiles(path))
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(path)
  }
  return out
}

describe('no code from strings in what ships (CSP without unsafe-eval)', () => {
  it('the static search finds each shape it looks for', () => {
    const planted = [
      'const f = new Function("return 1")',
      'const g = Function("a", "return a")',
      'globalThis.Function("x")',
      'eval("1 + 1")',
      'window.eval(code)',
      'setTimeout("tick()", 10)',
      'setInterval(`tick(${n})`, 10)',
      'setTimeout("a" + b, 10)',
      '(function () {}).constructor("return this")()',
      '(() => 0).constructor("x")',
    ]
    for (const code of planted) expect(dynamicCodeSites(code), code).toHaveLength(1)
    // and leaves alone what is not one: a callback timer, a method named like one, text that only mentions them
    for (const code of ['setTimeout(() => tick(), 10)', 'obj.evaluate(x)', '// new Function("x")', 'const s = "eval(1)"', 'x.constructor === Object']) {
      expect(dynamicCodeSites(code), code).toEqual([])
    }
  })

  it('no built module of core, vl or react makes code from a string', () => {
    const files = ['core', 'vl', 'react'].flatMap((p) => jsFiles(join(packages, p, 'dist')))
    // every package is built (the gate runs after `build`): a search over nothing would pass
    expect(files.filter((f) => f.includes(`${join('core', 'dist')}`)).length).toBeGreaterThan(50)
    expect(files.filter((f) => f.includes(`${join('vl', 'dist')}`)).length).toBeGreaterThan(5)
    expect(files.filter((f) => f.includes(`${join('react', 'dist')}`)).length).toBeGreaterThan(5)
    const sites = files.flatMap((f) => dynamicCodeSites(readFileSync(f, 'utf8'), f.slice(packages.length + 1)))
    expect(sites).toEqual([])
  })

  it('the whole corpus renders with code generation from strings refused', () => {
    const run = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', join(here, 'csp-corpus-run.mjs')], {
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 1 << 26,
    })
    expect(run.status, run.stderr.slice(-2000)).toBe(0)
    const result = JSON.parse(run.stdout.trim().split('\n').pop()!) as { specs: number; rendered: number; evalErrors: string[] }
    expect(result.evalErrors).toEqual([])
    // the corpus was there, and (nearly) all of it rendered: a run that rendered nothing proves nothing
    expect(result.specs).toBeGreaterThan(1000)
    expect(result.rendered).toBe(result.specs)
  })
})
