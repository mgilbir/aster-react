// @vitest-environment node
/**
 * Every loop the spec or its data sizes, in the transform, layout, raster and geo files, is bounded by the limits machinery, or says
 * why it needs not be. This is what makes a new loop safe by default: the clock (`maxTimeMs`) is cooperative and is seen only where a
 * loop ticks, and the built-in ceilings hold only where a site sizes its work through `allot` (docs/LIMITS.md). A loop the audits
 * found without either ran for minutes under a 100 ms budget, or never returned (force, label, the raster stroker, contour, heatmap).
 *
 * A loop passes when one of these holds:
 *   - its own body (not a loop nested in it) calls a meter: `meterTick`, `allot`, `allotUpTo`, `checkRowCount`, `checkItemCount` or
 *     `meterCoords` (a meter inside a nested loop does not count for the outer one: that one runs unticked when the inner is empty);
 *   - its bound is a constant: `i < 4`, `k < SUBY` (a numeric literal or a constant in capitals);
 *   - it is a single pass over a collection that already exists, at the top of its function (not inside another loop): `for...of`,
 *     `for...in`, `for (...; i < xs.length; ...)`, or the callback of `map` / `forEach` / `filter` / ... . Its cost is linear in memory
 *     the caller already holds; nested in a loop, it multiplies, and has to pass on its own;
 *   - the comment lines just above it (or above the statement holding it) say `bounded: <why>`: what bounds it (the enclosing loop
 *     ticks with its length as the cost, it stops after a fixed number of steps, it walks a tree the metered pass built, ...).
 *
 * What it cannot see: a loop inside a function that another loop calls (each function is read on its own), and a loop whose bound
 * the annotation misstates. Those are review's; the check makes the question be asked at every loop.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))

/** The files held to the rule: transforms, layouts, rasters, contours and the geo pipeline. */
const GATED = /^(transform(-[a-z]+)?|curve-fits|row-keys|raster(-[a-z]+)?|contour|label(-draw)?|wordcloud|force-layout|hierarchy-[a-z]+|treemap-tiling|circle-pack|quadtree|voronoi|delaunay|trellis|tree-walk|geo-[a-z-]+|topojson)\.ts$/

const METERS = new Set(['meterTick', 'allot', 'allotUpTo', 'checkRowCount', 'checkItemCount', 'meterCoords'])
const ITERATORS = new Set(['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'reduce', 'reduceRight', 'flatMap'])

type Loop = ts.IterationStatement | ts.ArrowFunction | ts.FunctionExpression

const isFunction = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)

/** A function passed to `xs.map(...)` and the like: a loop over `xs`. */
function isIteratorCallback(n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression {
  if (!(ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return false
  const call = n.parent
  return ts.isCallExpression(call) && call.arguments[0] === n && ts.isPropertyAccessExpression(call.expression) &&
    ITERATORS.has(call.expression.name.text)
}

const isLoop = (n: ts.Node): n is Loop => ts.isIterationStatement(n, false) || isIteratorCallback(n)

const isConstant = (e: ts.Expression): boolean =>
  ts.isNumericLiteral(e) || (ts.isIdentifier(e) && /^[A-Z][A-Z0-9_]*$/.test(e.text))

/** `i < 4`, `k < SUBY`: a for loop whose condition compares with a constant. */
function hasConstantBound(loop: Loop): boolean {
  if (!ts.isForStatement(loop) || !loop.condition || !ts.isBinaryExpression(loop.condition)) return false
  const { left, right, operatorToken } = loop.condition
  const k = operatorToken.kind
  const compares = k === ts.SyntaxKind.LessThanToken || k === ts.SyntaxKind.LessThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanToken || k === ts.SyntaxKind.GreaterThanEqualsToken
  return compares && (isConstant(right) || isConstant(left))
}

/** `xs.length`, or a `const` (or for-loop variable) of the function that holds `xs.length` and is not assigned again. */
function isLength(e: ts.Expression, loop: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'length'
  if (!ts.isIdentifier(e)) return false
  let scope: ts.Node | undefined = loop
  while (scope && !isFunction(scope) && !ts.isSourceFile(scope)) scope = scope.parent
  let found = false
  let assigned = false
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === e.text && n.initializer) {
      if (ts.isPropertyAccessExpression(n.initializer) && n.initializer.name.text === 'length') found = true
      else assigned = true
    }
    if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && n.left.text === e.text && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assigned = true
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && ts.isIdentifier(n.operand) && n.operand.text === e.text) assigned = true
    ts.forEachChild(n, visit)
  }
  if (scope) visit(scope)
  return found && !assigned
}

/** One pass over a collection that exists: `for...of`, `for...in`, `i < xs.length` (or `i < n`, `n = xs.length`), an iterator callback. */
function isCollectionPass(loop: Loop): boolean {
  if (ts.isForOfStatement(loop) || ts.isForInStatement(loop) || isIteratorCallback(loop)) return true
  if (!ts.isForStatement(loop) || !loop.condition || !ts.isBinaryExpression(loop.condition)) return false
  const { right, operatorToken } = loop.condition
  const below = operatorToken.kind === ts.SyntaxKind.LessThanToken || operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken
  return below && isLength(right, loop) && !grows(right, loop)
}

/** Whether the loop adds to the list whose `length` bounds it (a work queue, not a pass over what exists). */
function grows(bound: ts.Expression, loop: ts.ForStatement): boolean {
  if (!ts.isPropertyAccessExpression(bound)) return false
  const list = bound.expression.getText()
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['push', 'unshift', 'splice'].includes(n.expression.name.text) &&
      n.expression.expression.getText() === list) found = true
    ts.forEachChild(n, visit)
  }
  visit(loop.statement)
  return found
}

/** Whether the loop's own body calls a meter (not a loop nested in it, nor a function defined in it that is no iterator callback). */
function metersItself(loop: Loop): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (n !== loop && (isLoop(n) || isFunction(n))) return
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && METERS.has(n.expression.text)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  const body = ts.isIterationStatement(loop, false) ? loop.statement : loop.body
  // (the header of a for loop runs every iteration too: `for (...; ...; meterTick(...), i++)`)
  if (ts.isForStatement(loop)) {
    if (loop.condition) visit(loop.condition)
    if (loop.incrementor) visit(loop.incrementor)
  }
  if (ts.isWhileStatement(loop) || ts.isDoStatement(loop)) visit(loop.expression)
  visit(body)
  return found
}

/** The `bounded:` reason in the comment lines right above the statement that holds the loop (or above the loop itself). */
function boundedReason(loop: Loop, sf: ts.SourceFile): string | undefined {
  const lines = sf.text.split('\n')
  const above = (n: ts.Node): string | undefined => {
    let line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line - 1
    const comment: string[] = []
    while (line >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[line]!)) comment.unshift(lines[line--]!)
    const m = /bounded:\s*(\S.{2,})/.exec(comment.join(' '))
    return m?.[1]
  }
  let n: ts.Node = loop
  while (true) {
    const reason = above(n)
    if (reason) return reason
    const parent = n.parent
    if (!parent || ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return undefined
    n = parent
  }
}

/** The loops of one source that pass none of the rules, as `file:line: text`. */
export function unmeteredLoops(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const bad: string[] = []
  // `depth`: loops around the node, within its function
  const visit = (n: ts.Node, depth: number): void => {
    if (isLoop(n)) {
      const ok = metersItself(n) || hasConstantBound(n) || (depth === 0 && isCollectionPass(n)) || boundedReason(n, sf) !== undefined
      if (!ok) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
        bad.push(`${file}:${line + 1}: ${text.split('\n')[line]!.trim().slice(0, 100)}`)
      }
      ts.forEachChild(n, (c) => visit(c, depth + 1))
      return
    }
    ts.forEachChild(n, (c) => visit(c, isFunction(n) ? 0 : depth))
  }
  visit(sf, 0)
  return bad
}

const gatedFiles = (): string[] => readdirSync(SRC).filter((f) => GATED.test(f) && !f.includes('.test.')).sort()

describe('every loop the spec or its data sizes is metered (transform, layout, raster and geo files)', () => {
  it('covers the files it is meant to', () => {
    const files = gatedFiles()
    for (const f of ['transform.ts', 'transform-basic.ts', 'raster-stroke.ts', 'label.ts', 'contour.ts', 'wordcloud.ts', 'force-layout.ts', 'geo-clip.ts', 'hierarchy-nest.ts', 'raster-transforms.ts']) {
      expect(files).toContain(f)
    }
    expect(files.length).toBeGreaterThan(40)
  })

  it('no loop is left unticked without a stated bound', () => {
    const bad = gatedFiles().flatMap((f) => unmeteredLoops(f, readFileSync(join(SRC, f), 'utf8')))
    expect(bad, `${bad.length} loops without a meter call in their body, a constant bound or a "// bounded:" reason:\n${bad.join('\n')}`).toEqual([])
  })

  it('flags what it is meant to flag (the check itself)', () => {
    const flagged = (src: string): number => unmeteredLoops('x.ts', src).length
    // a loop sized by a parameter, with no tick
    expect(flagged('function f(n: number) { let s = 0; while (n-- > 0) s++; return s }')).toBe(1)
    expect(flagged('function f(n: number) { for (let i = 0; i < n; i++) g(i) }')).toBe(1)
    // the same loops, ticking or bounded by a constant, or with a reason
    expect(flagged('function f(n: number) { while (n-- > 0) meterTick("f") }')).toBe(0)
    expect(flagged('function f() { for (let q = 0; q < 4; q++) g(q) }')).toBe(0)
    expect(flagged('function f(n: number) {\n  // bounded: n is at most 3 here\n  while (n-- > 0) g()\n}')).toBe(0)
    // a pass over a collection at the top of its function is fine; nested in another loop, it is a product and is flagged
    expect(flagged('function f(xs: number[]) { for (const x of xs) g(x); xs.map((x) => x) }')).toBe(0)
    // a queue that grows as it is walked is no pass over what exists
    expect(flagged('function f(q: number[]) { for (let i = 0; i < q.length; i++) if (q[i]! > 0) q.push(q[i]! - 1) }')).toBe(1)
    expect(flagged('function f(xs: number[], ys: number[]) { for (const x of xs) for (const y of ys) g(x, y) }')).toBe(1)
    expect(flagged('function f(xs: number[], ys: number[]) { for (const x of xs) { meterTick("f", ys.length); ys.find((y) => y === x) } }')).toBe(1)
    // a tick in a nested loop does not meter the outer one (it never runs when the inner list is empty)
    expect(flagged('function f(n: number, xs: number[]) { for (let k = 0; k < n; k++) for (const x of xs) meterTick("f") }')).toBe(1)
    // a loop inside a function defined in a loop body is judged in its own function
    expect(flagged('function f(xs: number[]) { for (let i = 0; i < xs.length; i++) { const g = (ys: number[]) => { for (const y of ys) h(y) } ; g(xs) } }')).toBe(0)
  })
})
