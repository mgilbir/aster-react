/**
 * What the canonicalizer does with the document features no other table of normalize.test.ts names (C672).
 *
 * Each case is pinned to what it does today: most differ (a link's target, the root's size, a gradient's units, a paint-order swap
 * of a rotated rect...), a few are equal ON PURPOSE (comments, a leading space, `clip-rule`, a path with no `d` and no element, a
 * number within the 3-decimal rounding), and `%` / `cm` lengths and `<use>` are refused. A refactor of normalize.ts that drops one
 * of these is seen here, not in a differential that happens to draw it.
 */
import { describe, expect, it } from 'vitest'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const wrap = (body: string, w = 100, h = 80, rootAttrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${rootAttrs}><g fill="none" stroke-miterlimit="4">${body}</g></svg>`
const TEXT = '<text transform="translate(10,20)" fill="#000" font-family="sans-serif" font-size="10" text-anchor="start">hi</text>'
const RECT = '<rect x="5" y="6" width="20" height="10" fill="#4c78a8"/>'
const LINE = '<line x1="0" y1="0" x2="50" y2="0" stroke="#888" stroke-width="1"/>'
const PATH = '<path d="M0,0L20,0L20,20L5,5L0,20Z" fill="red"/>'
const grad = (extra = '', stop = '') => `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"${extra}><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"${stop}/></linearGradient></defs><rect width="30" height="30" fill="url(#g)"/>`
const IMG = '<image xlink:href="a.png" x="1" y="2" width="3" height="4"/>'
/** [name, oracle svg, aster svg]. */
const CASES: Array<[string, string, string]> = [
  ['<a> href u vs v', wrap(`<a xlink:href="u">${RECT}</a>`), wrap(`<a xlink:href="v">${RECT}</a>`)],
  ['<a href> vs no link', wrap(`<a xlink:href="u">${RECT}</a>`), wrap(RECT)],
  ['<a href=javascript:> vs https', wrap(`<a href="javascript:alert(1)">${RECT}</a>`), wrap(`<a href="https://x.test/">${RECT}</a>`)],
  ['<a target>', wrap(`<a xlink:href="u" target="_blank">${RECT}</a>`), wrap(`<a xlink:href="u">${RECT}</a>`)],
  ['root width', wrap(RECT, 100, 80), wrap(RECT, 101, 80)],
  ['root viewBox only', wrap(RECT), wrap(RECT).replace('viewBox="0 0 100 80"', 'viewBox="0 0 200 160"')],
  ['fill-rule evenodd', wrap(PATH), wrap(PATH.replace('<path', '<path fill-rule="evenodd"'))],
  ['text x attr', wrap(TEXT), wrap(TEXT.replace('<text', '<text x="7"'))],
  ['tspan dy 12 vs 60', wrap(TEXT.replace('>hi<', '><tspan>a</tspan><tspan x="0" dy="12">b</tspan><')), wrap(TEXT.replace('>hi<', '><tspan>a</tspan><tspan x="0" dy="60">b</tspan><'))],
  ['tspan split vs joined', wrap(TEXT.replace('>hi<', '><tspan>a</tspan><tspan x="0" dy="12">b</tspan><')), wrap(TEXT.replace('>hi<', '>ab<'))],
  ['visibility hidden', wrap(RECT), wrap(RECT.replace('<rect', '<rect visibility="hidden"'))],
  ['style attr fill vs attr fill other colour', wrap(RECT), wrap(RECT.replace('fill="#4c78a8"', 'style="fill: red"'))],
  ['style mix-blend-mode', wrap(RECT), wrap(RECT.replace('<rect', '<rect style="mix-blend-mode: multiply;"'))],
  ['style cursor', wrap(RECT), wrap(RECT.replace('<rect', '<rect style="cursor: pointer;"'))],
  ['cursor attr', wrap(RECT), wrap(RECT.replace('<rect', '<rect cursor="pointer"'))],
  ['gradientUnits', wrap(grad()), wrap(grad(' gradientUnits="userSpaceOnUse"'))],
  ['gradientTransform', wrap(grad()), wrap(grad(' gradientTransform="rotate(45)"'))],
  ['spreadMethod', wrap(grad()), wrap(grad(' spreadMethod="reflect"'))],
  ['stop-opacity', wrap(grad()), wrap(grad('', ' stop-opacity="0.2"'))],
  ['stop offset', wrap(grad()), wrap(grad().replace('offset="1"', 'offset="0.5"'))],
  ['image preserveAspectRatio', wrap(IMG), wrap(IMG.replace('<image', '<image preserveAspectRatio="none"'))],
  ['image style image-rendering', wrap(IMG), wrap(IMG.replace('<image', '<image style="image-rendering: pixelated;"'))],
  ['font-variant', wrap(TEXT), wrap(TEXT.replace('<text', '<text font-variant="small-caps"'))],
  ['letter-spacing', wrap(TEXT), wrap(TEXT.replace('<text', '<text letter-spacing="3"'))],
  ['direction rtl', wrap(TEXT), wrap(TEXT.replace('<text', '<text direction="rtl"'))],
  ['font-size 10 vs 10pt', wrap(TEXT), wrap(TEXT.replace('font-size="10"', 'font-size="10pt"'))],
  ['font-size 10 vs 10em', wrap(TEXT), wrap(TEXT.replace('font-size="10"', 'font-size="10em"'))],
  ['stroke-width 1 vs 1em', wrap(LINE), wrap(LINE.replace('stroke-width="1"', 'stroke-width="1em"'))],
  ['rect x 5 vs 5cm', wrap(RECT), wrap(RECT.replace('x="5"', 'x="5cm"'))],
  ['rect width 20 vs 20%', wrap(RECT), wrap(RECT.replace('width="20"', 'width="20%"'))],
  ['arc large flag', wrap('<path d="M0,10A10,10,0,0,1,20,10" stroke="red"/>'), wrap('<path d="M0,10A10,10,0,1,1,20,10" stroke="red"/>')],
  ['arc sweep flag', wrap('<path d="M0,10A10,10,0,0,1,20,10" stroke="red"/>'), wrap('<path d="M0,10A10,10,0,0,0,20,10" stroke="red"/>')],
  ['two identical rects vs one', wrap(RECT + RECT), wrap(RECT)],
  ['invalid colour vs black', wrap(RECT.replace('#4c78a8', 'not-a-colour')), wrap(RECT.replace('#4c78a8', 'black'))],
  ['invalid colour vs another invalid', wrap(RECT.replace('#4c78a8', 'not-a-colour')), wrap(RECT.replace('#4c78a8', 'nor-this'))],
  ['fill 0.43 vs black', wrap(RECT.replace('#4c78a8', '0.43')), wrap(RECT.replace('#4c78a8', 'black'))],
  ['fill true vs fill 1', wrap(RECT.replace('#4c78a8', 'true')), wrap(RECT.replace('#4c78a8', '1'))],
  ['fill invalid vs none', wrap(RECT.replace('#4c78a8', 'not-a-colour')), wrap(RECT.replace('#4c78a8', 'none'))],
  ['opacity 1.5 vs 1', wrap(RECT.replace('<rect', '<rect opacity="1.5"')), wrap(RECT)],
  ['rect rx', wrap(RECT), wrap(RECT.replace('<rect', '<rect rx="4"'))],
  ['text leading space', wrap(TEXT), wrap(TEXT.replace('>hi<', '> hi<'))],
  ['text inner double space', wrap(TEXT.replace('>hi<', '>a b<')), wrap(TEXT.replace('>hi<', '>a  b<'))],
  ['hidden rect vs absent', wrap(RECT.replace('<rect', '<rect display="none"') + LINE), wrap(LINE)],
  ['zero-width rect vs absent', wrap('<rect x="1" y="1" width="0" height="10" fill="red"/>' + LINE), wrap(LINE)],
  ['path with NaN vs absent', wrap('<path d="MNaN,0L5,5" stroke="red"/>' + LINE), wrap(LINE)],
  ['path d absent vs empty d', wrap('<path fill="red"/>' + LINE), wrap('<path d="" fill="red"/>' + LINE)],
  ['path without d vs absent element', wrap('<path fill="red"/>' + LINE), wrap(LINE)],
  ['clip-path on shape itself', wrap(`<defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>${RECT.replace('<rect', '<rect clip-path="url(#c)"')}`), wrap(RECT)],
  ['clipPath child transform', wrap(`<defs><clipPath id="c"><rect width="50" height="50"/></clipPath></defs><g clip-path="url(#c)">${RECT}</g>`), wrap(`<defs><clipPath id="c"><rect width="50" height="50" transform="translate(30,0)"/></clipPath></defs><g clip-path="url(#c)">${RECT}</g>`)],
  ['clip-rule', wrap(`<defs><clipPath id="c"><path d="M0,0h50v50h-50Z"/></clipPath></defs><g clip-path="url(#c)">${RECT}</g>`), wrap(`<defs><clipPath id="c"><path clip-rule="evenodd" d="M0,0h50v50h-50Z"/></clipPath></defs><g clip-path="url(#c)">${RECT}</g>`)],
  ['mask attr', wrap(RECT), wrap(RECT.replace('<rect', '<rect mask="url(#m)"'))],
  ['filter attr', wrap(RECT), wrap(RECT.replace('<rect', '<rect filter="blur(2px)"'))],
  ['root style other than background', wrap(RECT), wrap(RECT, 100, 80, ' style="opacity: 0.2;"')],
  ['root opacity attr', wrap(RECT), wrap(RECT, 100, 80, ' opacity="0.2"')],
  ['root transform attr', wrap(RECT), wrap(RECT, 100, 80, ' transform="scale(2)"')],
  ['num 5.0004 vs 5.0006', wrap(RECT.replace('x="5"', 'x="5.0004"')), wrap(RECT.replace('x="5"', 'x="5.0006"'))],
  ['num 5 vs 5.0004', wrap(RECT), wrap(RECT.replace('x="5"', 'x="5.0004"'))],
  ['stroke-width 0 vs no stroke', wrap(LINE.replace('stroke-width="1"', 'stroke-width="0"') + RECT), wrap(RECT)],
  ['dash 4 vs 4,4', wrap(LINE.replace('<line', '<line stroke-dasharray="4"')), wrap(LINE.replace('<line', '<line stroke-dasharray="4,4"'))],
  ['dash 4,2 vs 4,2,4,2', wrap(LINE.replace('<line', '<line stroke-dasharray="4,2"')), wrap(LINE.replace('<line', '<line stroke-dasharray="4,2,4,2"'))],
  ['fill rgba(255,0,0,.5) vs red+fill-opacity .5', wrap(RECT.replace('#4c78a8', 'rgba(255,0,0,0.5)')), wrap(RECT.replace('fill="#4c78a8"', 'fill="red" fill-opacity="0.5"'))],
  ['paint-order attr', wrap(TEXT.replace('<text', '<text stroke="red"')), wrap(TEXT.replace('<text', '<text stroke="red" paint-order="stroke"'))],
  ['vector-effect', wrap(LINE), wrap(LINE.replace('<line', '<line vector-effect="non-scaling-stroke"'))],
  ['comment + PI ignored', wrap(RECT), wrap('<!-- c -->' + RECT)],
  ['3 overlapping rects, the first and last swapped (same colour middle)', wrap('<rect x="0" y="0" width="10" height="10" fill="red"/><rect x="5" y="0" width="10" height="10" fill="green"/><rect x="10" y="0" width="10" height="10" fill="blue"/>'), wrap('<rect x="10" y="0" width="10" height="10" fill="blue"/><rect x="5" y="0" width="10" height="10" fill="green"/><rect x="0" y="0" width="10" height="10" fill="red"/>')],
  ['rotated rect over a rect swapped (bbox of the rotated one)', wrap('<rect x="30" y="30" width="6" height="6" fill="red"/><rect transform="rotate(45,20,20)" x="0" y="18" width="40" height="4" fill="blue"/>'), wrap('<rect transform="rotate(45,20,20)" x="0" y="18" width="40" height="4" fill="blue"/><rect x="30" y="30" width="6" height="6" fill="red"/>')],
  ['miter spike over a rect swapped', wrap('<path d="M0,40L30,42L0,44" stroke="red" stroke-width="4" stroke-miterlimit="50"/><rect x="45" y="38" width="10" height="8" fill="blue"/>'), wrap('<rect x="45" y="38" width="10" height="8" fill="blue"/><path d="M0,40L30,42L0,44" stroke="red" stroke-width="4" stroke-miterlimit="50"/>')],
  ['cubic bulge over a rect swapped', wrap('<path d="M0,40C0,-40 60,-40 60,40Z" fill="red"/><rect x="25" y="-15" width="10" height="6" fill="blue"/>'.replace('y="-15"', 'y="1"').replace('-40 60,-40', '-60 60,-60')), wrap('<rect x="25" y="1" width="10" height="6" fill="blue"/><path d="M0,40C0,-60 60,-60 60,40Z" fill="red"/>')],
  ['wide text over a rect swapped (text longer than the estimate?)', wrap(`${TEXT.replace('>hi<', '>WWWWWWWWWW<')}<rect x="85" y="12" width="10" height="8" fill="red"/>`), wrap(`<rect x="85" y="12" width="10" height="8" fill="red"/>${TEXT.replace('>hi<', '>WWWWWWWWWW<')}`)],
  ['end-anchored text over a rect to its left swapped', wrap(`${TEXT.replace('text-anchor="start"', 'text-anchor="end"').replace('translate(10,20)', 'translate(60,20)')}<rect x="45" y="12" width="10" height="8" fill="red"/>`), wrap(`<rect x="45" y="12" width="10" height="8" fill="red"/>${TEXT.replace('text-anchor="start"', 'text-anchor="end"').replace('translate(10,20)', 'translate(60,20)')}`)],
  ['image over a rect swapped', wrap(`<image xlink:href="a.png" x="0" y="0" width="30" height="30"/><rect x="10" y="10" width="5" height="5" fill="red"/>`), wrap(`<rect x="10" y="10" width="5" height="5" fill="red"/><image xlink:href="a.png" x="0" y="0" width="30" height="30"/>`)],
  ['unsupported: circle', wrap('<circle cx="5" cy="5" r="3" fill="red"/>'), wrap(RECT)],
  ['unsupported: use', wrap('<use xlink:href="#x"/>'), wrap(RECT)],
]

/** Equal on purpose: the canonical document is the same. */
const EQUAL = new Set(['text leading space', 'text inner double space', 'path d absent vs empty d', 'path without d vs absent element', 'clip-rule', 'num 5 vs 5.0004', 'comment + PI ignored'])
/** Refused: the canonicalizer throws rather than guess (a length it cannot turn into user units, an element it does not model). */
const REFUSED = new Set(['rect x 5 vs 5cm', 'rect width 20 vs 20%', 'unsupported: use'])

describe('canonicalizeSvg: the unpinned behaviours (C672)', () => {
  for (const [name, a, b] of CASES) {
    const how = REFUSED.has(name) ? 'is refused' : EQUAL.has(name) ? 'is equal' : 'differs'
    it(`${name} ${how}`, () => {
      if (REFUSED.has(name)) {
        expect(() => diffCanonical(canonicalizeSvg(a), canonicalizeSvg(b))).toThrow(/canonicalizeSvg: /)
      } else if (EQUAL.has(name)) {
        expect(diffCanonical(canonicalizeSvg(a), canonicalizeSvg(b))).toEqual([])
      } else {
        expect(diffCanonical(canonicalizeSvg(a), canonicalizeSvg(b)), `${name} was not detected`).not.toEqual([])
      }
    })
  }
  it('every name of the pinned sets is a case (a rename cannot leave a stale pin)', () => {
    const names = new Set(CASES.map(([n]) => n))
    for (const n of [...EQUAL, ...REFUSED]) expect(names.has(n), n).toBe(true)
    expect(CASES.length).toBeGreaterThanOrEqual(70)
  })
})

/**
 * N-batch of translucent / stroked circles (the batches of core's overlap-batch.ts): one path of circles whose painted boxes do not
 * meet is those circles, one record each; the box of a circle is the circle (its centre found from the arcs' ends) and its stroke, with
 * no miter corner, the scale of a transform its spectral norm; and a batch of circles that do meet is NOT taken for the circles one by one (their overlap composites once).
 */
describe('N-batch of circles whose strokes do not meet', () => {
  const circ = (x: number, y: number, r: number): string => `M${x + r},${y}A${r},${r},0,1,1,${x - r},${y}A${r},${r},0,1,1,${x + r},${y}`
  const paint = 'fill="#4c78a8" stroke="#222222" stroke-width="1.5" opacity="0.5"'
  const one = (d: string): string => `<path d="${d}" ${paint}/>`
  const batch = (...c: Array<[number, number, number]>): string => one(c.map(([x, y, r]) => circ(x, y, r)).join(''))
  const each = (...c: Array<[number, number, number]>): string => c.map(([x, y, r]) => one(circ(x, y, r))).join('')
  const noDiff = (a: string, b: string): string[] => diffCanonical(canonicalizeSvg(wrap(a)), canonicalizeSvg(wrap(b)))

  it('apart: a batch is its circles', () => {
    expect(noDiff(batch([20, 30, 4], [34, 30, 4], [60, 50, 3.5]), each([20, 30, 4], [34, 30, 4], [60, 50, 3.5]))).toEqual([])
  })
  it('the gap that separates two circles is the one their strokes and a pixel of antialiasing leave (1.5 / 2 + 1 each side)', () => {
    // centres 4 + 4 + 2 * (0.75 + 1) = 11.5 apart: boxes touch (meet); a hair more and they do not
    expect(noDiff(batch([20, 30, 4], [31.5, 30, 4]), each([20, 30, 4], [31.5, 30, 4]))).not.toEqual([])
    expect(noDiff(batch([20, 30, 4], [31.6, 30, 4]), each([20, 30, 4], [31.6, 30, 4]))).toEqual([])
  })
  it('overlapping circles in one path are not circles one by one', () => {
    expect(noDiff(batch([20, 30, 4], [25, 30, 4]), each([20, 30, 4], [25, 30, 4]))).not.toEqual([])
  })
})
