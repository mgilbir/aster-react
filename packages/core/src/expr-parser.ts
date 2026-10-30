/*
  The following expression parser is based on Esprima (http://esprima.org/).
  Original header comment and license for Esprima is included here:

  Copyright (C) 2013 Ariya Hidayat <ariya.hidayat@gmail.com>
  Copyright (C) 2013 Thaddee Tyl <thaddee.tyl@gmail.com>
  Copyright (C) 2013 Mathias Bynens <mathias@qiwi.be>
  Copyright (C) 2012 Ariya Hidayat <ariya.hidayat@gmail.com>
  Copyright (C) 2012 Mathias Bynens <mathias@qiwi.be>
  Copyright (C) 2012 Joost-Wim Boekesteijn <joost-wim@boekesteijn.nl>
  Copyright (C) 2012 Kris Kowal <kris.kowal@cixar.com>
  Copyright (C) 2012 Yusuke Suzuki <utatane.tea@gmail.com>
  Copyright (C) 2012 Arpad Borsos <arpad.borsos@googlemail.com>
  Copyright (C) 2011 Ariya Hidayat <ariya.hidayat@gmail.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/**
 * Aster's parser for the Vega expression language.
 *
 * The language is a small, side-effect-free subset of ECMAScript 5 expressions: literals, identifiers,
 * member access, calls, the unary operators ! - + ~, the binary and logical operators, the conditional
 * operator, array and object literals, and the keyword `if`. Everything else (assignment, `++`/`--`,
 * comma sequences, `typeof`/`void`/`delete`, functions, every other reserved word) is refused.
 *
 * Design: a lexer that produces one token at a time on demand, and a precedence-climbing parser with a
 * single token of lookahead that builds a plain ESTree-shaped tree (`Expr`). The tree is Aster's own
 * (just the fields the evaluator and the dependency scanners read); `expr-interpreter.ts` compiles it
 * to closures.
 *
 * What the observable behaviour of the language forces, and this file therefore keeps:
 *  - the set of accepted sources, including the identifier-character classes (tables that predate
 *    current Unicode and are part of the contract), octal and hex literals, string escapes, regular
 *    expression literals;
 *  - the diagnostics: V8-worded messages, one lexed token of lookahead (so a lexical error in the NEXT
 *    token is reported before a grammar error in the current one), and `error.index`, the scan position
 *    at the time of the error;
 *  - the nesting limit (an `AsterLimitError`, never a stack overflow).
 *
 * The identifier-character tables below descend from Esprima's (see the licence above); the rest is
 * Aster's own code, pinned to vega-expression's behaviour by a live and a generated differential
 * (`conformance/scripts/differential-vega-expression*.test.mts`).
 */

import { limitViolation } from './limits.js'

// --- the tree -----------------------------------------------------------------------------------

/** A property of an object literal; the key is an identifier or a string/number literal. */
export interface PropertyNode {
  type: 'Property'
  key: Expr
  value: Expr
}

export type Expr =
  | { type: 'Literal'; value: string | number | boolean | RegExp | null }
  | { type: 'Identifier'; name: string }
  | { type: 'MemberExpression'; computed: boolean; object: Expr; property: Expr }
  | { type: 'CallExpression'; callee: Expr; arguments: Expr[] }
  | { type: 'UnaryExpression'; operator: string; argument: Expr }
  | { type: 'BinaryExpression'; operator: string; left: Expr; right: Expr }
  | { type: 'LogicalExpression'; operator: string; left: Expr; right: Expr }
  | { type: 'ConditionalExpression'; test: Expr; consequent: Expr; alternate: Expr }
  | { type: 'ArrayExpression'; elements: Array<Expr | null> }
  | { type: 'ObjectExpression'; properties: PropertyNode[] }

/** The loose view of a tree node that dependency scanners walk generically. */
export interface AstNode {
  type: string
  [key: string]: unknown
}

/**
 * Deepest expression accepted: 1000 nested productions or a tree 1000 levels tall. Real specs stay far
 * below it; a chain `1+1+1+...` has tiny parser recursion but a tree as tall as it is long, so the tree
 * is measured too. Beyond it the evaluator's own recursion could not be trusted to stay off the stack.
 */
export const EXPR_MAX_DEPTH = 1000

// --- character classes ----------------------------------------------------------------------------

// Identifier characters beyond ASCII, as [gap, length] pairs in base 36 over the BMP starting at U+0080.
// These are the identifier-start and identifier-part classes of the tables vega-expression ships
// (Unicode 6-era, with their idiosyncrasies): a language contract, so they are measured against it, not
// replaced by the current \p{ID_Start}. Guarded by an exhaustive differential over every code unit.
const ID_START_PACKED =
  '16 0 b 0 5 0 6 m 2 u 2 cp 5 b f 4 8 0 2 0 3m 4 2 1 3 3 2 0 7 0 2 2 2 0 2 j 2 2a 2 3u 9 4l 2 11 3 0 8 12 21 q 6 2 1a 16 ' +
  '10 1 2 2q 2 0 g 1 8 1 b 2 3 0 h 0 2 t u 2g c 0 p w a 1 5 0 6 l 5 0 a 0 4 0 o o 20 i 2a 1h 4 0 j 0 8 9 g f 5 7 3 1 3 l ' +
  '2 6 2 0 4 3 4 0 h 0 e 1 2 2 f 1 k 5 5 1 3 l 2 6 2 1 2 1 2 1 w 3 2 0 k 2 h 8 2 2 2 l 2 6 2 1 2 4 4 0 j 0 g 1 10 7 3 1 3 ' +
  'l 2 6 2 1 2 4 4 0 v 1 2 2 g 0 i 0 2 5 4 2 2 3 4 1 2 0 2 1 4 1 4 2 4 b n 0 1h 7 2 2 2 m 2 f 4 0 r 1 7 1 10 7 2 2 2 m 2 ' +
  '9 2 4 4 0 x 0 2 1 g 1 j 7 2 2 2 14 3 0 h 0 i 1 p 5 6 h 4 n 2 8 2 0 3 6 1n 1b 2 1 d 6 1n 1 2 0 3 1 2 0 3 0 7 3 2 6 2 2 ' +
  '2 0 2 0 3 1 2 3 2 1 a 0 3 4 2 0 m 3 x 0 1s 7 2 z s 4 38 16 l 0 h 5 5 3 4 0 4 1 8 2 5 c d 0 i 11 2 0 6 0 3 16 2 98 2 3 ' +
  '3 6 2 0 2 3 3 14 2 3 3 w 2 3 3 6 2 0 2 3 3 e 2 1k 2 3 3 1u 12 f h 2c d h7 3 g 2 p 6 22 4 a 8 c 2 3 f h f h f c 2 2 g ' +
  '1f 10 0 5 0 1w 2f 9 14 2 0 6 1x b u 1e t 3 4 c 17 m 6 1l m a 1g 2b 0 2m 1a i 6 1k t e 1 b 17 r z 16 2 b z 30 3 2 3 4 1 ' +
  'a 5b 1t 7p 3 5 3 11 3 5 3 7 2 0 2 0 2 0 2 u 3 1g 2 6 2 0 4 2 2 6 4 3 3 5 5 c 6 2 2 6 39 0 e 0 h c 2u 0 5 0 3 9 2 0 4 4 ' +
  '7 0 2 0 2 0 2 3 2 a 3 3 6 4 5 0 i 14 22g 1a 2 1a 2 3o 7 3 4 1 d 11 2 0 6 0 3 1j 8 0 h m a 6 2 6 2 6 2 6 2 6 2 6 2 6 2 ' +
  '6 29 0 d2 2 q 8 8 4 3 4 5 2d 7 2 2 2h 2 3 6 14 4 2l i q 1i f e9 52t 23 g5o 1g wc 1w 19 3 7g 4 f b 1 l 1a h u 3 27 14 8 ' +
  '3 2u 3 3 2 t 3 1 1y a 2 2 2 3 2 m u 1f f 1d 1r 5 4 0 f r b m q s 8 1a t 0 h 4 2 9 b 4 2 14 o 2 2 7 l m 4 0 4 1d 2 0 4 ' +
  '1 3 4 3 0 2 0 p 2 3 a 8 2 d 5 3 5 3 5 a 6 2 6 2 16 2 3 5 1 2j y u 8mb d m 5 1c 6it a5 3 2x 13 6 d 4 6 0 2 9 2 c 2 4 2 ' +
  '0 2 1 2 1 2 2z y a2 j 1r 3 1h 15 b 39 4 2 3q 11 p 7 p c 2g 4 5 3 5 3 5 3 2 '
const ID_PART_PACKED =
  '16 0 b 0 5 0 6 m 2 u 2 cp 5 b f 4 8 0 2 0 i 38 2 1 3 3 2 0 7 0 2 2 2 0 2 j 2 2a 2 3u 2 4 3 4l 2 11 3 0 8 12 a 18 2 0 2 ' +
  '1 2 1 2 0 9 q 6 2 u a 6 21 5 2t 2 7 3 9 2 i 3 0 h 1m 3 2s f 1h 5 0 6 19 j r 1x i 1e 3j 3 9 2 i 2 7 3 1 3 l 2 6 2 0 4 3 ' +
  '3 8 3 1 3 3 9 0 5 1 2 4 3 b g 2 2 5 5 1 3 l 2 6 2 1 2 1 2 1 3 0 2 4 5 1 3 2 4 0 8 3 2 0 8 f c 2 2 8 2 2 2 l 2 6 2 1 2 ' +
  '4 3 9 2 2 2 2 3 0 g 3 3 9 i 2 2 7 3 1 3 l 2 6 2 1 2 4 3 8 3 1 3 2 9 1 5 1 2 4 3 9 2 0 h 1 2 5 4 2 2 3 4 1 2 0 2 1 4 1 ' +
  '4 2 4 b 5 4 4 2 2 3 3 0 7 0 f 9 h 3 2 7 2 2 2 m 2 f 4 7 2 2 2 3 8 1 2 1 7 3 3 9 i 2 2 7 2 2 2 m 2 9 2 4 3 8 2 2 2 3 8 ' +
  '1 8 0 2 3 3 9 2 1 f 2 2 7 2 2 2 14 3 7 2 2 2 4 9 0 9 3 3 9 b 5 3 1 2 h 4 n 2 8 2 0 3 6 4 0 5 5 2 0 2 7 7 9 3 1 e 1l 6 ' +
  'e 2 9 14 1 2 0 3 1 2 0 3 0 7 3 2 6 2 2 2 0 2 0 3 1 2 c 2 2 3 4 2 0 2 5 3 9 3 3 x 0 o 1 7 9 c 0 2 0 2 0 5 9 2 z 5 j 2 h ' +
  '2 z a 0 1m 21 7 25 3 11 2 0 6 0 3 16 2 98 2 3 3 6 2 0 2 3 3 14 2 3 3 w 2 3 3 6 2 0 2 3 3 e 2 1k 2 3 3 1u 3 2 x f h 2c ' +
  'd h7 3 g 2 p 6 22 4 a 8 c 2 6 c k c j d c 2 2 2 1 d 2b 4 0 5 1 3 9 y 2 3 9 7 2f 9 16 6 1x b u 2 b 5 b b 13 3 4 c 17 5 ' +
  'p 7 9 13 r 5 1q 2 s 3 a 7 9 e 0 9 d 1v 23 5 9 i 8 d 37 d 1j 9 9 4 1c 2b 2 2 y 2 1 7 6t 7 7t 3 5 3 11 3 5 3 7 2 0 2 0 2 ' +
  '0 2 u 3 1g 2 6 2 0 4 2 2 6 4 3 3 5 5 c 6 2 2 6 g 1 1e 1 k 0 t 0 e 0 h c 1g c 5 0 4 b i 0 5 0 3 9 2 0 4 4 7 0 2 0 2 0 2 ' +
  '3 2 a 3 3 6 4 5 0 i 14 22g 1a 2 1a 2 3o 7 8 d 11 2 0 6 0 3 1j 8 0 g n a 6 2 6 2 6 2 6 2 6 2 6 2 6 2 6 2 v 1c 0 d2 2 q ' +
  'e 2 4 3 4 5 2d 3 1 3 2 2 2h 2 3 6 14 4 2l i q 1i f e9 52t 23 g5o 1g wc 1w 19 3 7g 4 r l 1b 5 9 2 u 2 2a 12 8 3 2u 3 3 ' +
  '2 t 3 1 1y 1c p 1f d 1w c 9 7 n 4 0 5 19 3 z d s 4 1s f a 7 u 2 1i a d 3 9 7 m 4 20 p 2 3 f 3 4 b 5 3 5 3 5 a 6 2 6 2 ' +
  '16 2 3 5 1 2j 16 2 1 3 9 7 8mb d m 5 1c 6it a5 3 2x 13 6 d 4 6 b 2 c 2 4 2 0 2 1 2 1 2 2z y a2 j 1r 3 1h 15 b 5 f h d ' +
  '6 1 p 2 x 4 2 3q k 9 8 p 5 0 2 p c 2g 4 5 3 5 3 5 3 2 '

function unpack(packed: string): Uint16Array {
  const t = packed.trim().split(/\s+/)
  const out = new Uint16Array(t.length)
  let at = 0x80
  for (let i = 0; i < t.length; i += 2) {
    const lo = at + parseInt(t[i] as string, 36)
    at = lo + parseInt(t[i + 1] as string, 36)
    out[i] = lo
    out[i + 1] = at
  }
  return out
}
let idStart: Uint16Array | undefined
let idPart: Uint16Array | undefined

/** Is `c` inside one of the sorted [lo, hi] pairs of `ranges`? */
function inRanges(ranges: Uint16Array, c: number): boolean {
  let a = 0
  let b = (ranges.length >> 1) - 1
  while (a <= b) {
    const m = (a + b) >> 1
    if (c < (ranges[2 * m] as number)) b = m - 1
    else if (c > (ranges[2 * m + 1] as number)) a = m + 1
    else return true
  }
  return false
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isOctal = (c: number): boolean => c >= 48 && c <= 55
const hexValue = (c: number): number => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1)
const isLineTerminator = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029
/** Whitespace or a line terminator: all the lexer skips (the language has no comments). */
const isBlank = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xA0 ||
  (c >= 0x1680 && (c === 0x1680 || c === 0x180E || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF))
const isLetterOrUnderscore = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || c === 92
/** A backslash begins a `\uXXXX` escape, which the lexer validates itself. */
const isIdStart = (c: number): boolean => (c < 0x80 ? isLetterOrUnderscore(c) : c >= 0x80 && inRanges((idStart ??= unpack(ID_START_PACKED)), c))
const isIdPart = (c: number): boolean => (c < 0x80 ? isLetterOrUnderscore(c) || isDigit(c) : c >= 0x80 && inRanges((idPart ??= unpack(ID_PART_PACKED)), c))

/** Words that are never identifiers (`if` is the one the language uses, as a function name). */
const KEYWORDS = new Set([
  'if', 'in', 'do', 'var', 'for', 'new', 'try', 'let', 'this', 'else', 'case', 'void', 'with', 'enum', 'while', 'break', 'catch', 'throw',
  'const', 'yield', 'class', 'super', 'return', 'typeof', 'delete', 'switch', 'export', 'import', 'public', 'static', 'default', 'finally',
  'extends', 'package', 'private', 'function', 'continue', 'debugger', 'interface', 'protected', 'instanceof', 'implements',
])

// --- diagnostics ---------------------------------------------------------------------------------

const ILLEGAL = 'Unexpected token ILLEGAL'
const INVALID_REGEXP = 'Invalid regular expression'
const UNTERMINATED_REGEXP = 'Invalid regular expression: missing /'
const OCTAL = 'Octal literals are not allowed in strict mode.'
const DUPLICATE_KEY = 'Duplicate data property in object literal not allowed in strict mode'
/** What the language refuses on purpose (assignment, sequences, `++`, `typeof`, other keywords). */
const DISABLED = 'Disabled.'

type ScanError = Error & { index: number; description: string }
function scanError(message: string, index: number): ScanError {
  const err = new Error(message) as ScanError
  err.index = index
  err.description = message
  return err
}

// --- tokens and the lexer ------------------------------------------------------------------------

const EOF = 0
const NAME = 1
const KEYWORD = 2
const NULL = 3
const BOOLEAN = 4
const NUMBER = 5
const STRING = 6
const PUNCT = 7

class Token {
  constructor(
    readonly kind: number,
    readonly value: string | number | undefined,
    readonly start: number,
    readonly end: number,
    /** A legacy octal literal or escape: scanned, but refused when the grammar uses it. */
    readonly octal = false,
  ) {}
}

/**
 * Scans tokens on demand from `pos`. Errors carry `pos` as `index`, so `pos` is kept where the scan
 * stood, token by token: that position is part of the diagnostics.
 */
class Lexer {
  pos = 0
  private readonly n: number

  constructor(private readonly src: string) {
    this.n = src.length
  }

  private fail(message: string): never {
    throw scanError(message, this.pos)
  }

  /** The next token, after any whitespace. */
  scan(): Token {
    const s = this.src
    let p = this.pos
    while (p < this.n && isBlank(s.charCodeAt(p))) p++
    this.pos = p
    if (p >= this.n) return new Token(EOF, undefined, p, p)
    const c = s.charCodeAt(p)
    if (isIdStart(c)) return this.name()
    if (c === 34 || c === 39) return this.string(c)
    if (isDigit(c) || (c === 46 && isDigit(s.charCodeAt(p + 1)))) return this.number()
    return this.punctuator()
  }

  /** Exactly `len` hex digits (of a `\x` or `\u` escape) as a number. */
  private hexDigits(len: number): number {
    let code = 0
    for (let i = 0; i < len; i++) {
      const d = this.pos < this.n ? hexValue(this.src.charCodeAt(this.pos)) : -1
      if (d < 0) this.fail(ILLEGAL)
      code = code * 16 + d
      this.pos++
    }
    return code
  }

  private name(): Token {
    const s = this.src
    const start = this.pos
    let id = ''
    let chunk = start
    let p = s.charCodeAt(start) === 92 ? start : start + 1
    for (;;) {
      while (p < this.n) {
        const c = s.charCodeAt(p)
        if (c === 92 || !isIdPart(c)) break
        p++
      }
      if (p >= this.n || s.charCodeAt(p) !== 92) break
      // a \uXXXX escape: its character must itself be valid in this position
      id += s.slice(chunk, p)
      this.pos = p + 1
      if (s.charCodeAt(p + 1) !== 117) this.fail(ILLEGAL)
      this.pos = p + 2
      const code = this.hexDigits(4)
      if (code === 0 || code === 92 || !(p === start ? isIdStart(code) : isIdPart(code))) this.fail(ILLEGAL)
      id += String.fromCharCode(code)
      p = chunk = this.pos
    }
    id += s.slice(chunk, p)
    this.pos = p
    const kind = id.length === 1 ? NAME
      : KEYWORDS.has(id) ? KEYWORD
      : id === 'null' ? NULL
      : id === 'true' || id === 'false' ? BOOLEAN
      : NAME
    return new Token(kind, id, start, p)
  }

  private punctuator(): Token {
    const s = this.src
    const p = this.pos
    const c = s.charCodeAt(p)
    const c1 = s.charCodeAt(p + 1)
    const c2 = s.charCodeAt(p + 2)
    let len: number
    switch (c) {
      case 46: case 40: case 41: case 59: case 44: case 123: case 125: case 91: case 93: case 58: case 63: case 126: // . ( ) ; , { } [ ] : ? ~
        len = 1
        break
      case 61: // =  ==  ===  =>
        len = c1 === 61 ? (c2 === 61 ? 3 : 2) : c1 === 62 ? 2 : 1
        break
      case 33: // !  !=  !==
        len = c1 === 61 ? (c2 === 61 ? 3 : 2) : 1
        break
      case 60: // <  <=  <<  <<=
        len = c1 === 61 ? 2 : c1 === 60 ? (c2 === 61 ? 3 : 2) : 1
        break
      case 62: // >  >=  >>  >>=  >>>  >>>=
        len = c1 === 61 ? 2 : c1 === 62 ? (c2 === 61 ? 3 : c2 === 62 ? (s.charCodeAt(p + 3) === 61 ? 4 : 3) : 2) : 1
        break
      case 43: case 45: case 38: case 124: // + - & |  and their doubled and `=` forms
        len = c1 === c || c1 === 61 ? 2 : 1
        break
      case 42: case 37: case 94: // * % ^
        len = c1 === 61 ? 2 : 1
        break
      case 47: // /  /=  (a second slash is refused: there are no comments)
        if (c1 === 47) this.fail(ILLEGAL)
        len = c1 === 61 ? 2 : 1
        break
      default:
        return this.fail(ILLEGAL)
    }
    this.pos = p + len
    return new Token(PUNCT, s.slice(p, p + len), p, p + len)
  }

  private number(): Token {
    const s = this.src
    const start = this.pos
    let p = start
    if (s.charCodeAt(p) === 46) {
      p++ // a leading '.': no integer part
    } else {
      if (s.charCodeAt(p) === 48) {
        const next = s.charCodeAt(p + 1)
        if (next === 120 || next === 88) return this.hex(start)
        if (isOctal(next)) return this.octal(start)
        if (isDigit(next)) {
          this.pos = p + 1
          this.fail(ILLEGAL) // 08, 09
        }
      }
      while (isDigit(s.charCodeAt(p))) p++
      if (s.charCodeAt(p) === 46) p++
    }
    while (isDigit(s.charCodeAt(p))) p++
    const e = s.charCodeAt(p)
    if (e === 101 || e === 69) {
      p++
      const sign = s.charCodeAt(p)
      if (sign === 43 || sign === 45) p++
      if (!isDigit(s.charCodeAt(p))) {
        this.pos = p
        this.fail(ILLEGAL)
      }
      while (isDigit(s.charCodeAt(p))) p++
    }
    this.pos = p
    if (isIdStart(s.charCodeAt(p))) this.fail(ILLEGAL)
    return new Token(NUMBER, parseFloat(s.slice(start, p)), start, p)
  }

  private hex(start: number): Token {
    const s = this.src
    let p = start + 2
    this.pos = p
    while (hexValue(s.charCodeAt(p)) >= 0) p++
    this.pos = p
    if (p === start + 2 || isIdStart(s.charCodeAt(p))) this.fail(ILLEGAL)
    return new Token(NUMBER, parseInt(s.slice(start + 2, p), 16), start, p)
  }

  private octal(start: number): Token {
    const s = this.src
    let p = start + 2
    while (isOctal(s.charCodeAt(p))) p++
    this.pos = p
    if (isIdStart(s.charCodeAt(p)) || isDigit(s.charCodeAt(p))) this.fail(ILLEGAL)
    return new Token(NUMBER, parseInt(s.slice(start + 1, p), 8), start, p, true)
  }

  private string(quote: number): Token {
    const s = this.src
    const start = this.pos
    let value = ''
    let octal = false
    let chunk = start + 1
    let p = chunk
    while (p < this.n) {
      const c = s.charCodeAt(p)
      if (c === quote) {
        this.pos = p + 1
        return new Token(STRING, value + s.slice(chunk, p), start, p + 1, octal)
      }
      if (c === 92) {
        value += s.slice(chunk, p)
        this.pos = p + 1
        octal = this.escape((v) => { value += v }) || octal
        chunk = p = this.pos
        continue
      }
      p++
      if (isLineTerminator(c)) break
    }
    this.pos = p
    return this.fail(ILLEGAL)
  }

  /**
   * The escape after a backslash (`pos` is just past it): appends its character through `out` and
   * reports whether it was a legacy octal escape. A backslash at the very end reads one character
   * beyond the source, which moves `pos` past it: the diagnostic's `index` shows that.
   */
  private escape(out: (v: string) => void): boolean {
    const s = this.src
    const ch = s[this.pos++]
    if (ch !== undefined && isLineTerminator(ch.charCodeAt(0))) {
      // a line continuation contributes nothing; CR LF is one terminator
      if (ch === '\r' && s[this.pos] === '\n') this.pos++
      return false
    }
    switch (ch) {
      case 'u': case 'x':
        if (s[this.pos] === '{') {
          this.pos++
          out(this.codePointEscape())
        } else {
          out(String.fromCharCode(this.hexDigits(ch === 'u' ? 4 : 2)))
        }
        return false
      case 'n': out('\n'); return false
      case 'r': out('\r'); return false
      case 't': out('\t'); return false
      case 'b': out('\b'); return false
      case 'f': out('\f'); return false
      case 'v': out('\v'); return false
      case undefined: return false
    }
    const first = ch.charCodeAt(0)
    if (!isOctal(first)) {
      out(ch)
      return false
    }
    // \0 alone is NUL. Any other octal escape is legacy: the string scans, and is refused where the grammar
    // uses it, so its value is never seen (the digits that follow simply scan as ordinary characters)
    const legacy = first !== 48 || isOctal(s.charCodeAt(this.pos))
    out(legacy ? ch : '\0')
    return legacy
  }

  /** `{XXXXXX}` after `\u` / `\x`, up to U+10FFFF. */
  private codePointEscape(): string {
    const s = this.src
    let ch = s[this.pos]
    if (ch === '}') this.fail(ILLEGAL)
    let code = 0
    while (this.pos < this.n) {
      ch = s[this.pos++]
      const d = hexValue((ch as string).charCodeAt(0))
      if (d < 0) break
      code = code * 16 + d
    }
    if (code > 0x10FFFF || ch !== '}') this.fail(ILLEGAL)
    return String.fromCodePoint(code)
  }

  /** A regular expression literal starting at `pos` (a slash): its value, or null when this engine rejects the flags. */
  regex(): RegExp | null {
    const s = this.src
    const start = this.pos
    let p = start + 1
    let inClass = false
    let closed = false
    while (p < this.n) {
      const c = s.charCodeAt(p++)
      if (c === 92) {
        // The escaped character is read without a bounds check, as the language's own scanner does: a
        // pattern ending in a backslash fails with the engine's TypeError, and that message is the contract.
        const escaped = s[p++] as string
        if (isLineTerminator(escaped.charCodeAt(0))) {
          this.pos = p
          this.fail(UNTERMINATED_REGEXP)
        }
      } else if (isLineTerminator(c)) {
        this.pos = p
        this.fail(UNTERMINATED_REGEXP)
      } else if (inClass) {
        if (c === 93) inClass = false
      } else if (c === 47) {
        closed = true
        break
      } else if (c === 91) {
        inClass = true
      }
    }
    if (!closed) {
      this.pos = p
      this.fail(UNTERMINATED_REGEXP)
    }
    const body = s.slice(start + 1, p - 1)
    const flagsAt = p
    while (p < this.n && isIdPart(s.charCodeAt(p))) {
      p++
      if (s.charCodeAt(p - 1) === 92 && p < this.n) {
        this.pos = p
        this.fail(ILLEGAL)
      }
    }
    this.pos = p
    const flags = s.slice(flagsAt, p)
    if (/[^gimuy]/.test(flags)) this.fail(INVALID_REGEXP)

    // Validate the pattern without the flags (the way the language always has): under `u`, code point
    // escapes and surrogate pairs stand in as one ordinary character first, so a pattern valid only
    // with `u` is not rejected here.
    let probe = body
    if (flags.includes('u')) {
      probe = probe
        .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex: string) => {
          if (parseInt(hex, 16) > 0x10FFFF) this.fail(INVALID_REGEXP)
          return 'x'
        })
        .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, 'x')
    }
    try {
      new RegExp(probe)
    } catch {
      this.fail(INVALID_REGEXP)
    }
    // with the real flags it may still be unconstructible (a pattern not valid under them): the literal is then null
    try {
      return new RegExp(body, flags)
    } catch {
      return null
    }
  }
}

// --- the parser ----------------------------------------------------------------------------------

/** Binary operator precedence (higher binds tighter); all are left-associative. */
const PRECEDENCE = new Map<string, number>([
  ['||', 1], ['&&', 2], ['|', 3], ['^', 4], ['&', 5],
  ['==', 6], ['!=', 6], ['===', 6], ['!==', 6],
  ['<', 7], ['>', 7], ['<=', 7], ['>=', 7], ['instanceof', 7], ['in', 7],
  ['<<', 8], ['>>', 8], ['>>>', 8],
  ['+', 9], ['-', 9],
  ['*', 10], ['/', 10], ['%', 10],
])

class Parser {
  private readonly lx: Lexer
  /** The next unconsumed token. */
  private tok: Token
  /** Nesting of unary and conditional productions, against EXPR_MAX_DEPTH. */
  private depth = 0
  /** Regular-expression literals this engine could not construct (their value is null): they still count as regular expressions for the height limit. */
  unconstructible: Set<Expr> | undefined

  constructor(src: string) {
    this.lx = new Lexer(src)
    this.tok = this.lx.scan()
    this.lx.pos = 0
  }

  atEnd(): boolean {
    return this.tok.kind === EOF
  }

  /** Consume the next token. The one after it is scanned now, so its lexical error comes first. */
  private take(): Token {
    const t = this.tok
    this.lx.pos = t.end
    this.tok = this.lx.scan()
    this.lx.pos = t.end
    return t
  }

  private fail(message: string, at: number): never {
    throw scanError(message, at)
  }

  private unexpected(t: Token): never {
    const at = this.lx.pos
    switch (t.kind) {
      case EOF: return this.fail('Unexpected end of input', at)
      case NUMBER: return this.fail('Unexpected number', at)
      case STRING: return this.fail('Unexpected string', at)
      case NAME: return this.fail('Unexpected identifier', at)
      case KEYWORD: return this.fail('Unexpected reserved word', at)
      default: return this.fail(`Unexpected token ${String(t.value)}`, at)
    }
  }

  private is(punct: string): boolean {
    return this.tok.kind === PUNCT && this.tok.value === punct
  }

  private expect(punct: string): void {
    const t = this.take()
    if (t.kind !== PUNCT || t.value !== punct) this.unexpected(t)
  }

  expression(): Expr {
    const e = this.conditional()
    if (this.is(',')) throw new Error(DISABLED) // no sequence expressions
    return e
  }

  private enter(): void {
    if (++this.depth > EXPR_MAX_DEPTH) throw limitViolation(`maxDepth ${this.depth} > ${EXPR_MAX_DEPTH} (expression nesting)`)
  }

  private conditional(): Expr {
    this.enter()
    const test = this.binary(0)
    let result = test
    if (this.is('?')) {
      this.take()
      const consequent = this.conditional()
      this.expect(':')
      const alternate = this.conditional()
      result = { type: 'ConditionalExpression', test, consequent, alternate }
    }
    this.depth--
    return result
  }

  /** Precedence climbing: operators binding tighter than `floor` extend the left operand. */
  private binary(floor: number): Expr {
    let left = this.unary()
    for (;;) {
      const t = this.tok
      const prec = t.kind === PUNCT || t.kind === KEYWORD ? PRECEDENCE.get(t.value as string) ?? 0 : 0
      if (prec <= floor) return left
      this.take()
      const right = this.binary(prec)
      const operator = t.value as string
      left = operator === '||' || operator === '&&'
        ? { type: 'LogicalExpression', operator, left, right }
        : { type: 'BinaryExpression', operator, left, right }
    }
  }

  private unary(): Expr {
    this.enter()
    const t = this.tok
    let result: Expr
    if (t.kind === PUNCT || t.kind === KEYWORD) {
      if (t.kind === PUNCT && (t.value === '++' || t.value === '--')) throw new Error(DISABLED)
      if (t.kind === PUNCT && (t.value === '+' || t.value === '-' || t.value === '~' || t.value === '!')) {
        this.take()
        result = { type: 'UnaryExpression', operator: t.value as string, argument: this.unary() }
      } else if (t.kind === KEYWORD && (t.value === 'delete' || t.value === 'void' || t.value === 'typeof')) {
        throw new Error(DISABLED)
      } else {
        result = this.postfix()
      }
    } else {
      result = this.postfix()
    }
    this.depth--
    return result
  }

  /** A call/member chain, refusing a trailing `++`/`--`. */
  private postfix(): Expr {
    let e = this.primary()
    for (;;) {
      if (this.is('.')) {
        this.take()
        this.lx.pos = this.tok.start
        const t = this.take()
        if (t.kind !== NAME && t.kind !== KEYWORD && t.kind !== BOOLEAN && t.kind !== NULL) this.unexpected(t)
        e = { type: 'MemberExpression', computed: false, object: e, property: { type: 'Identifier', name: t.value as string } }
      } else if (this.is('(')) {
        e = { type: 'CallExpression', callee: e, arguments: this.args() }
      } else if (this.is('[')) {
        this.take()
        const property = this.expression()
        this.expect(']')
        e = { type: 'MemberExpression', computed: true, object: e, property }
      } else {
        break
      }
    }
    if (this.is('++') || this.is('--')) throw new Error(DISABLED)
    return e
  }

  private args(): Expr[] {
    const list: Expr[] = []
    this.expect('(')
    if (!this.is(')')) {
      for (;;) {
        list.push(this.conditional())
        if (this.is(')')) break
        this.expect(',')
      }
    }
    this.expect(')')
    return list
  }

  private primary(): Expr {
    const t = this.tok
    if (t.kind === PUNCT) {
      if (t.value === '(') {
        this.take()
        const e = this.expression()
        this.expect(')')
        return e
      }
      if (t.value === '[') return this.array()
      if (t.value === '{') return this.object()
    }
    this.lx.pos = t.start
    // `if` is the one keyword that reads as a name (the function `if(test, a, b)`); that includes a *string*
    // whose text is `if`, which the language has always parsed as the name too
    if (t.kind === NAME || t.value === 'if') return { type: 'Identifier', name: this.take().value as string }
    switch (t.kind) {
      case STRING: case NUMBER:
        if (t.octal) this.fail(OCTAL, this.lx.pos)
        return { type: 'Literal', value: this.take().value as string | number }
      case KEYWORD: throw new Error(DISABLED)
      case BOOLEAN: this.take(); return { type: 'Literal', value: t.value === 'true' }
      case NULL: this.take(); return { type: 'Literal', value: null }
    }
    if (t.kind === PUNCT && (t.value === '/' || t.value === '/=')) {
      const value = this.lx.regex()
      // the token after the literal is scanned from where the literal ended
      const end = this.lx.pos
      this.tok = this.lx.scan()
      this.lx.pos = end
      const literal: Expr = { type: 'Literal', value }
      if (value === null) (this.unconstructible ??= new Set()).add(literal)
      return literal
    }
    return this.unexpected(this.take())
  }

  private array(): Expr {
    const elements: Array<Expr | null> = []
    this.expect('[')
    while (!this.is(']')) {
      if (this.is(',')) {
        this.take()
        elements.push(null) // a hole
      } else {
        elements.push(this.conditional())
        if (!this.is(']')) this.expect(',')
      }
    }
    this.take()
    return { type: 'ArrayExpression', elements }
  }

  private object(): Expr {
    const properties: PropertyNode[] = []
    const seen = new Set<string>()
    this.expect('{')
    while (!this.is('}')) {
      const property = this.property()
      const key = property.key.type === 'Identifier' ? property.key.name : String((property.key as { value: unknown }).value)
      if (seen.has(key)) this.fail(DUPLICATE_KEY, this.lx.pos)
      seen.add(key)
      properties.push(property)
      if (!this.is('}')) this.expect(',')
    }
    this.expect('}')
    return { type: 'ObjectExpression', properties }
  }

  private property(): PropertyNode {
    this.lx.pos = this.tok.start
    if (this.tok.kind === EOF || this.tok.kind === PUNCT) return this.unexpected(this.tok)
    // the key is a string or number literal, or any word read as a name (keywords and true/false/null included)
    const t = this.take()
    let key: Expr
    if (t.kind === STRING || t.kind === NUMBER) {
      if (t.octal) this.fail(OCTAL, this.lx.pos)
      key = { type: 'Literal', value: t.value as string | number }
    } else {
      key = { type: 'Identifier', name: t.value as string }
    }
    this.expect(':')
    return { type: 'Property', key, value: this.conditional() }
  }
}

/** Fail if the tree is more than EXPR_MAX_DEPTH levels tall. Iterative: the tree can be far deeper than any recursion could take. */
function checkHeight(root: Expr, unconstructible: Set<Expr> | undefined): void {
  const nodes: Array<Expr | PropertyNode> = [root]
  const levels = [1]
  const exceeds = (level: number): never => { throw limitViolation(`maxDepth ${level} > ${EXPR_MAX_DEPTH} (expression nesting)`) }
  while (nodes.length > 0) {
    const node = nodes.pop() as Expr | PropertyNode
    const level = levels.pop() as number
    if (level > EXPR_MAX_DEPTH) exceeds(level)
    const push = (child: Expr | PropertyNode | null): void => {
      if (child !== null) { nodes.push(child); levels.push(level + 1) }
    }
    switch (node.type) {
      case 'Literal':
        // a regular expression is a value of its own, one level below its literal
        if ((node.value instanceof RegExp || unconstructible?.has(node)) && level + 1 > EXPR_MAX_DEPTH) exceeds(level + 1)
        break
      case 'Identifier': break
      case 'MemberExpression': push(node.object); push(node.property); break
      case 'CallExpression': push(node.callee); node.arguments.forEach(push); break
      case 'UnaryExpression': push(node.argument); break
      case 'BinaryExpression': case 'LogicalExpression': push(node.left); push(node.right); break
      case 'ConditionalExpression': push(node.test); push(node.consequent); push(node.alternate); break
      case 'ArrayExpression': node.elements.forEach(push); break
      case 'ObjectExpression': node.properties.forEach(push); break
      case 'Property': push(node.key); push(node.value); break
    }
  }
}

/** Parse a Vega expression string to its tree. Throws on anything the language does not accept. */
export function parseExpression(code: string): Expr {
  const parser = new Parser(code)
  const expr = parser.expression()
  if (!parser.atEnd()) throw new Error('Unexpect token after expression.')
  // every node takes at least one character of source, so a short source cannot be too tall
  if (code.length > EXPR_MAX_DEPTH) checkHeight(expr, parser.unconstructible)
  return expr
}
