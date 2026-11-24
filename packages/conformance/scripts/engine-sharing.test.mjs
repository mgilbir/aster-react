/**
 * No harness hands one object to both engines (audit C61).
 *
 *  - At run time, for every conformance test: scripts/engine-sharing.setup.mjs (in the root vitest.config.mjs) fails a test that
 *    hands an object vega has read to Aster, or the other way round. Its fixtures (test-fixtures/engine-sharing) are run here:
 *    a test that shares the spec, and one that shares only the rows, must fail; one that goes through forEngines must pass.
 *  - Statically, for the gate scripts that vitest never runs (run-sweep, run, probe, the gallery...): in no function of a
 *    harness file under packages/conformance is one variable passed to an oracle entry (vega.parse, renderWithVega(Checked),
 *    vegaSvg, embed) and to an Aster entry (renderSpec, compileChart, evaluateChart, loadSpecData, a compiler...). The rule is
 *    shown to flag a function that does.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from '../../../scripts/lib/spawn-async.mjs'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(PKG, '..', '..')
const ts = createRequire(join(PKG, 'package.json'))('typescript')

const ORACLE = new Set(['renderWithVega', 'renderWithVegaChecked', 'vegaSvg', 'embed', 'compareToVega'])
const ASTER = new Set(['renderSpec', 'compileChart', 'evaluateChart', 'compileOurs', 'compileVL', 'normalizeChartSpec', 'loadSpecData', 'getChartInfo', 'evaluate', 'createChartStream'])

/** `name:line` of every variable one function hands to an oracle entry and to an Aster entry. */
export function sharedHandOffs(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const scopes = new Map()
  const owner = (n) => {
    let p = n.parent
    while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent
    return p
  }
  const calleeName = (e) => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null)
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.arguments.length) {
      const name = calleeName(n.expression)
      const vegaParse = name === 'parse' && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'vega'
      const side = vegaParse || ORACLE.has(name) ? 'oracle' : ASTER.has(name) ? 'aster' : null
      let arg = name === 'embed' ? n.arguments[1] : n.arguments[0]
      while (arg && (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg) || ts.isNonNullExpression(arg))) arg = arg.expression
      if (side && arg && ts.isIdentifier(arg)) {
        const fn = owner(n)
        const s = scopes.get(fn) ?? { oracle: new Map(), aster: new Map() }
        scopes.set(fn, s)
        s[side].set(arg.text, sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  const out = []
  for (const s of scopes.values()) for (const [id, line] of s.oracle) if (s.aster.has(id)) out.push(`${id}:${line}`)
  return out
}

function harnessFiles() {
  const out = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|mts|mjs|tsx)$/.test(n) && !/\.d\.m?ts$/.test(n)) out.push(p)
    }
  }
  for (const d of ['src', 'scripts', 'test']) walk(join(PKG, d))
  return out
}

describe('no harness hands one object to both engines (C61)', () => {
  it('the static rule flags a function that hands one variable to both, and not one that copies', () => {
    const shares = "async function f(spec) { const a = await renderWithVega(spec); const b = renderSpec(spec as never); return [a, b] }"
    const copies = "async function f(spec) { return forEngines(spec, (o, a) => Promise.all([renderWithVega(o), renderSpec(a as never)])) }"
    const apart = "async function f(spec) { return renderWithVega(spec) }\nfunction g(spec) { return renderSpec(spec) }"
    expect(sharedHandOffs('x.ts', shares)).toEqual(['spec:1'])
    expect(sharedHandOffs('x.ts', copies)).toEqual([])
    expect(sharedHandOffs('x.ts', apart)).toEqual([])
  })

  it('no harness file of packages/conformance does it', () => {
    const files = harnessFiles()
    expect(files.length).toBeGreaterThan(100)
    const found = files.flatMap((f) => sharedHandOffs(f, readFileSync(f, 'utf8')).map((s) => `${relative(PKG, f)} ${s}`))
    expect(found).toEqual([])
  })

  it('at run time: a test that shares the spec or its rows fails, one that copies passes', async () => {
    const r = await spawnAsync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/conformance/test-fixtures/engine-sharing/vitest.config.mjs', '--reporter=json'], { cwd: ROOT, timeout: 180_000 })
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
    const outcome = Object.fromEntries(json.testResults.flatMap((f) => f.assertionResults.map((a) => [a.title, { status: a.status, message: a.failureMessages.join('\n') }])))
    expect(outcome['shares one spec between the engines']?.status).toBe('failed')
    expect(outcome['shares one spec between the engines']?.message).toMatch(/handed one object to both engines[\s\S]*renderSpec \(aster\) was handed an object vega\.parse \(oracle\) was handed first/)
    expect(outcome['shares the rows between the engines']?.status).toBe('failed')
    expect(outcome['gives each engine its own copy']?.status).toBe('passed')
  }, 200_000)
})
