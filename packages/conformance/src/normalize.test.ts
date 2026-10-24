/**
 * The canonicalizer is the oracle's ruler. These tests plant one difference at
 * a time and require it to be reported (C38), and require representation-only
 * differences to be ignored (so the strictness is not noise).
 */
import { describe, expect, it } from 'vitest'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const wrap = (body: string, w = 100, h = 80, rootAttrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${rootAttrs}><g fill="none" stroke-miterlimit="4">${body}</g></svg>`

function diff(a: string, b: string): string[] {
  return diffCanonical(canonicalizeSvg(a), canonicalizeSvg(b))
}

const TEXT = '<text transform="translate(10,20)" fill="#000" font-family="sans-serif" font-size="10" text-anchor="start">hi</text>'
const RECT = '<rect x="5" y="6" width="20" height="10" fill="#4c78a8"/>'
const LINE = '<line x1="0" y1="0" x2="50" y2="0" stroke="#888" stroke-width="1"/>'
const grad = (c: string, extra = '') => `<defs><linearGradient id="gradient_9" x1="0" y1="0" x2="1" y2="0"${extra}><stop offset="0" stop-color="red"/><stop offset="1" stop-color="${c}"/></linearGradient></defs><rect width="30" height="30" fill="url(#gradient_9)"/>`
const clip = (w: number) => `<defs><clipPath id="clip1"><rect x="0" y="0" width="${w}" height="20"/></clipPath></defs><g clip-path="url(#clip1)">${RECT}</g>`

/** [name, oracle svg, aster svg]: every pair differs visibly and must be reported. */
const PLANTED: Array<[string, string, string]> = [
  ['rotation', wrap(TEXT), wrap(TEXT.replace('translate(10,20)', 'translate(10,20) rotate(30)'))],
  ['rotation of a rect', wrap(RECT), wrap(`<g transform="rotate(10)">${RECT}</g>`)],
  ['font-size', wrap(TEXT), wrap(TEXT.replace('font-size="10"', 'font-size="11"'))],
  ['text-anchor', wrap(TEXT), wrap(TEXT.replace('text-anchor="start"', 'text-anchor="middle"'))],
  ['font-weight', wrap(TEXT), wrap(TEXT.replace('<text', '<text font-weight="bold"'))],
  ['font-style', wrap(TEXT), wrap(TEXT.replace('<text', '<text font-style="italic"'))],
  ['font-family', wrap(TEXT), wrap(TEXT.replace('sans-serif', 'serif'))],
  ['font-family omitted', wrap(TEXT), wrap(TEXT.replace(' font-family="sans-serif"', ''))],
  ['text content', wrap(TEXT), wrap(TEXT.replace('>hi<', '>ho<'))],
  ['opacity 0 vs absent element', wrap(`${TEXT.replace('<text', '<text opacity="0"')}${RECT}`), wrap(RECT)],
  ['opacity 0 vs opacity 1', wrap(TEXT.replace('<text', '<text opacity="0"')), wrap(TEXT.replace('<text', '<text opacity="1"'))],
  ['group opacity', wrap(`<g opacity="0.5">${RECT}</g>`), wrap(RECT)],
  ['stroke-opacity', wrap(LINE), wrap(LINE.replace('<line', '<line stroke-opacity="0.3"'))],
  ['stroke-linecap', wrap(LINE), wrap(LINE.replace('<line', '<line stroke-linecap="round"'))],
  ['stroke-linejoin', wrap(LINE.replace('line', 'path').replace(/x1.*?x2="50" y2="0"/, 'd="M0,0L5,5L10,0"')), wrap(LINE.replace('line', 'path').replace(/x1.*?x2="50" y2="0"/, 'd="M0,0L5,5L10,0"').replace('<path', '<path stroke-linejoin="round"'))],
  ['stroke-miterlimit', wrap(LINE), wrap(LINE.replace('<line', '<line stroke-miterlimit="2"'))],
  ['dash offset', wrap(LINE.replace('<line', '<line stroke-dasharray="4,2"')), wrap(LINE.replace('<line', '<line stroke-dasharray="4,2" stroke-dashoffset="1"'))],
  ['dash array', wrap(LINE.replace('<line', '<line stroke-dasharray="4,2"')), wrap(LINE.replace('<line', '<line stroke-dasharray="4,3"'))],
  ['a valid dash array vs an invalid one (which is no dashing)', wrap(LINE.replace('<line', '<line stroke-dasharray="4,2"')), wrap(LINE.replace('<line', '<line stroke-dasharray="dashed"'))],
  ['a valid dash array vs a negative one', wrap(LINE.replace('<line', '<line stroke-dasharray="4,2"')), wrap(LINE.replace('<line', '<line stroke-dasharray="4,-2"'))],
  ['scale', wrap(RECT), wrap(`<g transform="scale(2)">${RECT}</g>`)],
  ['scale of text', wrap(TEXT), wrap(TEXT.replace('translate(10,20)', 'translate(10,20) scale(1.5)'))],
  ['image vs nothing', wrap(`${RECT}<image xlink:href="data:image/png;base64,AAAA" x="1" y="2" width="3" height="4"/>`), wrap(RECT)],
  ['image href', wrap('<image xlink:href="a.png" x="1" y="2" width="3" height="4"/>'), wrap('<image xlink:href="b.png" x="1" y="2" width="3" height="4"/>')],
  ['image x', wrap('<image xlink:href="a.png" x="1" y="2" width="3" height="4"/>'), wrap('<image xlink:href="a.png" x="2" y="2" width="3" height="4"/>')],
  ['image y', wrap('<image xlink:href="a.png" x="1" y="2" width="3" height="4"/>'), wrap('<image xlink:href="a.png" x="1" y="3" width="3" height="4"/>')],
  ['image width', wrap('<image xlink:href="a.png" x="1" y="2" width="3" height="4"/>'), wrap('<image xlink:href="a.png" x="1" y="2" width="4" height="4"/>')],
  ['image height', wrap('<image xlink:href="a.png" x="1" y="2" width="3" height="4"/>'), wrap('<image xlink:href="a.png" x="1" y="2" width="3" height="5"/>')],
  ['gradient stop colour', wrap(grad('blue')), wrap(grad('green'))],
  ['gradient stop count', wrap(grad('blue')), wrap(grad('blue').replace('<stop offset="1"', '<stop offset="0.5" stop-color="white"/><stop offset="1"'))],
  ['gradient direction', wrap(grad('blue')), wrap(grad('blue').replace('x2="1"', 'x2="0"'))],
  ['clip-path geometry', wrap(clip(20)), wrap(clip(30))],
  ['clip-path vs none', wrap(clip(20)), wrap(RECT)],
  ['unknown attribute', wrap(RECT), wrap(RECT.replace('<rect', '<rect data-foo="1"'))],
  ['bogus text angle attribute', wrap(TEXT), wrap(TEXT.replace('<text', '<text angle="30"'))],
  ['paint order of overlapping marks', wrap(`${RECT}<rect x="10" y="6" width="20" height="10" fill="red"/>`), wrap(`<rect x="10" y="6" width="20" height="10" fill="red"/>${RECT}`)],
  ['swapped touching rects', wrap('<rect x="0" y="0" width="10" height="10" fill="red"/><rect x="10" y="0" width="10" height="10" fill="blue"/>'), wrap('<rect x="10" y="0" width="10" height="10" fill="blue"/><rect x="0" y="0" width="10" height="10" fill="red"/>')],
  ['thick stroke reaches its neighbour', wrap('<line x1="0" y1="10" x2="40" y2="10" stroke="red" stroke-width="12"/><rect x="0" y="14" width="40" height="5" fill="blue"/>'), wrap('<rect x="0" y="14" width="40" height="5" fill="blue"/><line x1="0" y1="10" x2="40" y2="10" stroke="red" stroke-width="12"/>')],
  ['text overlapping a rect swapped', wrap(`${TEXT}<rect x="12" y="10" width="20" height="8" fill="red"/>`), wrap(`<rect x="12" y="10" width="20" height="8" fill="red"/>${TEXT}`)],
  ['a swap across a barrier', wrap('<rect x="0" y="0" width="10" height="10" fill="red"/><g opacity="0.5"><rect x="50" y="0" width="10" height="10" fill="blue"/></g><rect x="90" y="0" width="5" height="5" fill="green"/>'), wrap('<rect x="90" y="0" width="5" height="5" fill="green"/><g opacity="0.5"><rect x="50" y="0" width="10" height="10" fill="blue"/></g><rect x="0" y="0" width="10" height="10" fill="red"/>')],
  ['background colour', wrap(`<rect width="100" height="80" fill="white"/>${RECT}`), wrap(`<rect width="100" height="80" fill="black"/>${RECT}`)],
  ['stroke colour', wrap(LINE), wrap(LINE.replace('#888', '#889'))],
  ['fill-opacity', wrap(RECT), wrap(RECT.replace('<rect', '<rect fill-opacity="0.5"'))],
  ['translation', wrap(RECT), wrap(`<g transform="translate(0.01,0)">${RECT}</g>`)],
  ['stroke-width', wrap(LINE), wrap(LINE.replace('stroke-width="1"', 'stroke-width="2"'))],
  ['text dy', wrap(TEXT), wrap(TEXT.replace('<text', '<text dy="3"'))],
  ['display none', wrap(RECT), wrap(RECT.replace('<rect', '<rect display="none"'))],
  // the accessibility structure (N3): a screen reader sees each of these
  ['an extra group', wrap(`<g><g class="x">${RECT}</g></g>`), wrap(RECT)],
  ['group nesting', wrap(`<g class="a"><g class="b">${RECT}</g></g>`), wrap(`<g class="a"></g><g class="b">${RECT}</g>`)],
  ['group class', wrap(`<g class="mark-group role-axis">${RECT}</g>`), wrap(`<g class="mark-group role-legend">${RECT}</g>`)],
  ['group role', wrap(`<g role="graphics-symbol">${RECT}</g>`), wrap(`<g role="graphics-object">${RECT}</g>`)],
  ['role present vs absent', wrap(`<g class="a">${RECT}</g>`), wrap(`<g class="a" role="graphics-symbol">${RECT}</g>`)],
  ['aria-roledescription', wrap(`<g role="graphics-symbol" aria-roledescription="axis">${RECT}</g>`), wrap(`<g role="graphics-symbol" aria-roledescription="legend">${RECT}</g>`)],
  ['aria-label', wrap(`<g role="graphics-symbol" aria-label="X-axis">${RECT}</g>`), wrap(`<g role="graphics-symbol" aria-label="Y-axis">${RECT}</g>`)],
  ['aria-label present vs absent', wrap(`<g role="graphics-symbol">${RECT}</g>`), wrap(`<g role="graphics-symbol" aria-label="x">${RECT}</g>`)],
  ['aria-hidden', wrap(`<g class="a">${RECT}</g>`), wrap(`<g class="a" aria-hidden="true">${RECT}</g>`)],
  ['the aria-label of a shape', wrap(RECT.replace('<rect', '<rect role="graphics-symbol" aria-label="a: 1"')), wrap(RECT.replace('<rect', '<rect role="graphics-symbol" aria-label="a: 2"'))],
  ['a shape\'s ARIA vs none', wrap(RECT.replace('<rect', '<rect role="graphics-symbol" aria-label="a: 1"')), wrap(RECT)],
  ['background path of a group item', wrap(`<g><path class="background" aria-hidden="true" d="M0,0h0v0h0Z"/>${RECT}</g>`), wrap(`<g>${RECT}</g>`)],
  ['foreground path of a group item', wrap(`<g>${RECT}<path class="foreground" aria-hidden="true" d="" display="none"/></g>`), wrap(`<g>${RECT}</g>`)],
]

describe('canonicalizeSvg bites: every planted difference is reported', () => {
  for (const [name, a, b] of PLANTED) {
    it(name, () => {
      expect(diff(a, b), `${name} was not detected`).not.toEqual([])
    })
  }
})

/** Same picture, different representation: must canonicalize equal. */
const EQUIVALENT: Array<[string, string, string]> = [
  ['attribute order', wrap('<rect x="5" y="6" width="20" height="10" fill="#4c78a8"/>'), wrap('<rect fill="#4c78a8" height="10" width="20" y="6" x="5"/>')],
  ['translate vs x/y', wrap('<rect transform="translate(5,6)" width="20" height="10" fill="#4c78a8"/>'), wrap(RECT)],
  ['nested translates', wrap(`<g transform="translate(2,3)"><g transform="translate(3,3)"><rect width="20" height="10" fill="#4c78a8"/></g></g>`), wrap(`<g transform="translate(5,6)"><g><rect width="20" height="10" fill="#4c78a8"/></g></g>`)],
  ['rotate about a point', wrap(`<rect transform="rotate(30,10,10)" width="4" height="4" fill="red"/>`), wrap(`<rect transform="translate(10,10) rotate(30) translate(-10,-10)" width="4" height="4" fill="red"/>`)],
  ['matrix vs scale', wrap(`<rect transform="scale(2)" width="4" height="4" fill="red"/>`), wrap(`<rect transform="matrix(2,0,0,2,0,0)" width="4" height="4" fill="red"/>`)],
  ['colour spellings', wrap('<rect width="4" height="4" fill="white"/><rect width="4" height="4" x="9" fill="#ff0000"/>'), wrap('<rect width="4" height="4" fill="#FFF"/><rect width="4" height="4" x="9" fill="rgb(255, 0, 0)"/>')],
  ['numeric formatting', wrap('<rect x="5.0000001" y="6" width="20.0" height="10" fill="red"/>'), wrap('<rect x="5" y="6.0004" width="20" height="10" fill="red"/>').replace('6.0004', '6')],
  ['px unit', wrap(TEXT), wrap(TEXT.replace('font-size="10"', 'font-size="10px"'))],
  ['inherited from group', wrap('<g stroke="#888" stroke-width="1"><line x1="0" y1="0" x2="50" y2="0"/></g>'), wrap(`<g>${LINE}</g>`)],
  ['dead stroke props', wrap(RECT), wrap(RECT.replace('<rect', '<rect stroke-width="5" stroke-linecap="round" stroke-dasharray="3,3" stroke-opacity="0.2"'))],
  ['invalid dasharray: a word', wrap(LINE), wrap(LINE.replace('<line', '<line stroke-dasharray="dashed"'))],
  ['invalid dasharray: a negative length', wrap(LINE), wrap(LINE.replace('<line', '<line stroke-dasharray="4,-2"'))],
  ['invalid dasharray: NaN', wrap(LINE), wrap(LINE.replace('<line', '<line stroke-dasharray="NaN,2"'))],
  ['invalid dasharray: an empty list item', wrap(LINE), wrap(LINE.replace('<line', '<line stroke-dasharray="4,,2"'))],
  ['invalid vs another invalid dasharray', wrap(LINE.replace('<line', '<line stroke-dasharray="dashed"')), wrap(LINE.replace('<line', '<line stroke-dasharray="1 2 x"'))],
  ['initial values', wrap(LINE), wrap(LINE.replace('<line', '<line opacity="1" stroke-opacity="1" stroke-linecap="butt" stroke-linejoin="miter" stroke-dashoffset="0"'))],
  ['relative vs absolute path', wrap('<path d="M1,1h10v10h-10Z" fill="red"/>'), wrap('<path d="M1,1L11,1L11,11L1,11Z" fill="red"/>')],
  ['H/V vs L', wrap('<path d="M1,1H11V11H1Z" fill="red"/>'), wrap('<path d="M1 1 L 11 1 L 11 11 L 1 11 Z" fill="red"/>')],
  ['gradient ids', wrap(grad('blue')), wrap(grad('blue').replace(/gradient_9/g, 'gradient_77'))],
  ['clip ids', wrap(clip(20)), wrap(clip(20).replace(/clip1/g, 'clip42'))],
  ['unreferenced defs', wrap(RECT), wrap(`<defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs>${RECT}`)],
  // (the structure is compared, see N-structure; what is NOT: the transform of a wrapper, hyperlink wrappers, ARIA-less shapes' classes, entity spelling)
  ['a wrapper keeps its structure line whatever its transform', wrap(`<g class="a" transform="translate(1,0)"><g>${RECT.replace('x="5"', 'x="4"')}</g></g>`), wrap(`<g class="a"><g>${RECT}</g></g>`)],
  ['class/role/aria of a shape without ARIA is not structure; pointer-events never is', wrap(RECT), wrap(RECT.replace('<rect', '<rect class="a" pointer-events="none"'))],
  ['an aria-label spelt with character references', wrap(`<g role="graphics-symbol" aria-label="it's &amp; &lt;b&gt;">${RECT}</g>`), wrap(`<g role="graphics-symbol" aria-label="it&#39;s &#x26; &#60;b&#62;">${RECT}</g>`)],
  ['an <a> wrapper is transparent', wrap(`<g class="m">${RECT}</g>`), wrap(`<g class="m"><a xlink:href="u">${RECT}</a></g>`.replace('<a xlink:href="u">', '<a>'))],
  ['class tokens spaced differently', wrap(`<g class="mark-rect  role-mark">${RECT}</g>`), wrap(`<g class="mark-rect role-mark">${RECT}</g>`)],
  ['undashed line endpoints', wrap(LINE), wrap('<line x1="50" y1="0" x2="0" y2="0" stroke="#888" stroke-width="1"/>')],
  ['bg rect vs style bg', wrap(`<rect width="100" height="80" fill="white"/>${RECT}`), wrap(RECT, 100, 80, ' style="background-color: white;"')],
  ['text em dy vs px', wrap(TEXT.replace('<text', '<text dy="0.5em"')), wrap(TEXT.replace('<text', '<text dy="5"'))],
  ['swapped disjoint rects (paint order cannot matter)', wrap('<rect x="0" y="0" width="10" height="10" fill="red"/><rect x="50" y="0" width="10" height="10" fill="blue"/>'), wrap('<rect x="50" y="0" width="10" height="10" fill="blue"/><rect x="0" y="0" width="10" height="10" fill="red"/>')],
  ['text and a far-away line swap', wrap(`${TEXT}<line x1="0" y1="70" x2="90" y2="70" stroke="#888"/>`), wrap(`<line x1="0" y1="70" x2="90" y2="70" stroke="#888"/>${TEXT}`)],
  ['zero-size butt path', wrap(`<path d="M0,0h0v0h0Z" fill="red"/>${RECT}`), wrap(RECT)],
]

describe('canonicalizeSvg ignores representation-only differences', () => {
  for (const [name, a, b] of EQUIVALENT) {
    it(name, () => {
      expect(diff(a, b)).toEqual([])
    })
  }
})

describe('canonicalizeSvg misc contracts', () => {
  it('dangling references compare equal to each other but not to a real def', () => {
    const dangling = (id: string) => wrap(`<rect width="4" height="4" fill="url(#${id})"/>`)
    expect(diff(dangling('gradient_0'), dangling('gradient_9'))).toEqual([])
    expect(diff(dangling('gradient_0'), wrap(grad('blue')))).not.toEqual([])
  })

  it('keeps opacity 0 elements as their own records', () => {
    const r = canonicalizeSvg(wrap(`${TEXT.replace('<text', '<text opacity="0"')}${RECT}`))
    expect(r.records).toHaveLength(2)
    expect(r.records.some((rec) => rec.includes('opacity=0'))).toBe(true)
  })

  it('a non-full-canvas or stroked first rect is NOT the background', () => {
    expect(diff(wrap(`<rect width="100" height="80" fill="white" stroke="#000"/>${RECT}`), wrap(RECT))).not.toEqual([])
    expect(diff(wrap(`<rect width="99" height="80" fill="white"/>${RECT}`), wrap(RECT))).not.toEqual([])
    expect(diff(wrap(`${RECT}<rect width="100" height="80" fill="white"/>`), wrap(RECT))).not.toEqual([])
  })

  it('a rect equal to itself is not a background check (C76): a half-width rect at 0,0 survives', () => {
    expect(canonicalizeSvg(wrap('<rect width="50" height="80" fill="white"/>')).records).toHaveLength(1)
  })

  it('throws on constructs it cannot judge instead of ignoring them', () => {
    expect(() => canonicalizeSvg(wrap('<foreignObject/>'))).toThrow(/unsupported element/)
    expect(() => canonicalizeSvg(wrap('<rect width="1" height="1" transform="wobble(3)"/>'))).toThrow(/transform/)
  })
})
