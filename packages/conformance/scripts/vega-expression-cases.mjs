/**
 * Inputs of the LIVE expression differential (`differential-vega-expression.test.mts`):
 * source strings for the parser (the AST is the contract), and for the evaluator (language
 * semantics through the default function table). Inputs only; formerly recorded by
 * `gen-vectors.mjs` into `vega-expression.json` (92 parse + 23 parseError + 74 evalLang +
 * 18 evalDatum + 10 evalSecurity cases).
 */

export const parseCodes = [
  '1', '1.5', '.5', '0x1f', '017', '1e3', '1E+3', '"abc"', "'abc'", '"a\\u00e9b"',
  'true', 'false', 'null', 'NaN', 'PI', 'E', 'MAX_VALUE',
  'a', 'datum', 'item', 'event', '$signal', '_value', 'if',
  'a + b', 'a - b', 'a * b', 'a / b', 'a % b', 'a === b',
  'a || b', 'a && b', '!a', '-a', '+a', '~a',
  'a < b', 'a > b', 'a <= b', 'a >= b', 'a == b', 'a != b', 'a === b', 'a !== b',
  'a & b', 'a | b', 'a ^ b', 'a << b', 'a >> b', 'a >>> b',
  'a + b * c', '(a + b) * c', 'a + b + c', 'a < b && c > d || !e',
  'a ? b : c', 'a ? b : c ? d : e', 'a ? b ? c : d : e',
  'datum.value', 'datum["a b"]', 'datum[0]', 'datum.a.b', 'datum["a"]["b"]',
  'datum.map.length', 'fn(a, b)', 'fn()', 'datum.fn(a)', 'fn(a)(b)',
  '[1, 2, 3]', '[]', '[a, [b, c]]', '{a: 1}', '{"a b": 1, c: d}', '{}',
  'if (a, b, c)', 'upper(datum.name)', '_space(1)', 'datum.list[0] + datum.list[1]',
  'a in b', 'a instanceof b', 'indatum("table", datum.x)',
  '/ab+c/g', '/[a-z]/i', '/\\d/', '/x/u', '/(?:)/', '""', "''",
  '  a  +  b  ', 'a\tb', 'a b'.replace(' ', ''), '(((a)))', '$signal',
]

export const parseErrorCodes = [
  '1 +', 'a = 1', 'a, b', 'function () {}', '++a', 'a++', 'typeof a', 'void 0',
  'delete a.b', 'var a', 'new A()', '"unterminated', "'x", '1x', '09', '0x',
  '#', 'a..b', '{a: 1, a: 2}', 'while (a)', 'case 1', '\\u0041', '.',
]

export const evalLangCodes = [
  '1 + 2 * 3', '(1 + 2) * 3', '2 * 3 + 1', '10 / 4', '7 % 3', '1 + "a"', '"a" + 1',
  '"1" == 1', '"1" === 1', 'null == undefined', 'null === undefined', 'NaN === NaN',
  '1/0', '-0 === 0', '1/-0', '!"a"', '~0', '-"5"', '+true', 'true ? 1 : 2',
  'false ? 1 : 2', 'null || "fallback"', '0 && "never"', '"a" && "b"',
  '1 < 2 < 3', '3 > 2 > 1', '"b" > "a"', '"a" > 1', 'undefined + 1', 'null + 1',
  '[1, 2, 3]', '[1, 2, 3][1]', '({a: 1}).a', '({a: 1, b: "x"}).b', '({})',
  'PI', 'E', 'LN10', 'MAX_VALUE', 'NaN', 'abs(-5)', 'max(1, 2, 3)', 'min(4, 2)',
  'round(2.5)', 'ceil(1.2)', 'floor(-1.2)', 'pow(2, 10)', 'sqrt(16)', 'isNaN(NaN)',
  'isFinite(1)', 'upper("abc")', 'lower("ABC")', 'trim("  x  ")', 'split("a,b", ",")',
  'indexof("abc", "b")', 'lastindexof("abc", "c")', 'substring("abcdef", 1, 3)',
  'length([1, 2, 3])', 'join(["a", "b"], "-")', 'reverse([1, 2, 3])', 'sort([3, 1, 2])',
  'parseFloat("1.5")', 'parseInt("12px")', 'replace("aaa", "a", "b")',
  'year(datetime(2024, 2, 10))', 'month(datetime(2024, 2, 10))',
  'utcyear(datetime(2024, 2, 10))', 'date(datetime(2024, 2, 10))',
  'regexp("a+")', 'test(/b/, "abc")', 'test("b", "abc")',
  'encodeURIComponent("a b")', 'clamp(5, 0, 3)', 'clamp(-5, 0, 3)',
]

export const evalDatum = {
  a: 1, b: 2, 'a b': 3, list: [1, 2], nested: { deep: true }, name: 'hello',
  s: '5', flag: true,
}
export const evalParams = { shift: 5, bound: 10 }

export const evalCodes = [
  'datum.a + datum.b', 'datum["a b"]', 'datum.list[0] + datum.list[1]',
  'datum.nested.deep', 'datum.name + "!"', 'upper(datum.name)',
  'datum.a > 1 ? "big" : "small"', 'datum.s * 2', '+datum.s',
  'datum.a + $shift', 'datum.b * $bound', 'datum.flag ? datum.a : datum.b',
  'if (datum.a > 0, datum.a, -datum.a)', 'max(datum.a, datum.b, $shift)',
  'length(datum.list)', 'datum.missing', 'datum.nested.missing',
  'clamp(datum.a + $shift, 0, $bound)',
]

export const evalErrorCodes = [
  'undefinedFn(1)', 'a.b.c', 'null.x', '{}.x.y',
  'Function("return 1")()', 'datum.constructor', '({toString: 1})',
  'eval("1+1")', 'setTimeout(null, 0)',
  'a in b', // Binary has no 'in' op upstream; pin the resulting throw
]
