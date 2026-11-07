/** The specs of the mark-orientation differential (vl-mark-orientation.test.ts). */

const DATA = { values: Array.from({ length: 24 }, (_, i) => ({ q: (i * 7) % 13 + 1, q2: (i * 3) % 11 + 2, n: ['A', 'B', 'C'][i % 3], o: i % 4, t: `2020-0${1 + (i % 9)}-01`, b0: i, b1: i + 1, c0: 2 * i, c1: 2 * i + 2 })) }
export type Case = [string, Record<string, any>]
/** Every group of cases, in order. */
export const GROUPS: Array<[title: string, cases: Case[]]> = []
const cases = (title: string, list: Case[]): void => {
  GROUPS.push([title, list.map(([name, spec]) => [name, { data: DATA, ...spec }] as Case)])
}
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
const o = (field: string) => ({ field, type: 'ordinal' })
const t = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'temporal', ...extra })
const binned = (field: string) => q(field, { bin: 'binned' })

// --- a rule over pre-binned channels --------------------------------------------------------------------------------------------

const RULE_X = [['a nominal', n('n')], ['an ordinal', o('o')], ['a measure', q('q')], ['a pre-binned', binned('b0')]] as const
const rules: Case[] = []
for (const [name, def] of RULE_X) {
  rules.push([`pre-binned y with y2 over ${name} x`, { mark: 'rule', encoding: { x: def, y: binned('b0'), y2: q('b1') } }])
  rules.push([`pre-binned x with x2 over ${name} y`, { mark: 'rule', encoding: { y: def, x: binned('b0'), x2: q('b1') } }])
}
rules.push(
  ['pre-binned on both axes with both seconds', { mark: 'rule', encoding: { x: binned('b0'), x2: q('b1'), y: binned('c0'), y2: q('c1') } }],
  ['pre-binned x and x2 alone', { mark: 'rule', encoding: { x: binned('b0'), x2: q('b1') } }],
  ['pre-binned y and y2 alone', { mark: 'rule', encoding: { y: binned('b0'), y2: q('b1') } }],
  ['pre-binned x alone', { mark: 'rule', encoding: { x: binned('b0') } }],
  ['pre-binned y alone', { mark: 'rule', encoding: { y: binned('b0') } }],
  ['pre-binned x over a measure y', { mark: 'rule', encoding: { x: binned('b0'), y: q('q') } }],
  ['a measure x over pre-binned y', { mark: 'rule', encoding: { x: q('q'), y: binned('b0') } }],
  ['pre-binned x with x2, orient vertical asked', { mark: { type: 'rule', orient: 'vertical' }, encoding: { x: binned('b0'), x2: q('b1'), y: n('n') } }],
  ['pre-binned y with y2, orient horizontal asked', { mark: { type: 'rule', orient: 'horizontal' }, encoding: { y: binned('b0'), y2: q('b1'), x: n('n') } }],
  ['pre-binned with a colour', { mark: 'rule', encoding: { x: binned('b0'), x2: q('b1'), y: n('n'), color: n('n') } }],
  ['pre-binned x with x2 and a size', { mark: 'rule', encoding: { x: binned('b0'), x2: q('b1'), y: n('n'), size: { value: 4 } } }],
)
cases('@aster-charts/vl == vega-lite: a rule over pre-binned channels', rules)

// --- marks over two channels that are neither measures ---------------------------------------------------------------------------

const NON_MEASURES: Array<[string, Record<string, unknown> | undefined]> = [['none', undefined], ['nominal', n('n')], ['ordinal', o('o')], ['temporal', t('t')], ['binned', q('q', { bin: true })], ['time unit', t('t', { timeUnit: 'month' })]]
for (const mark of ['bar', 'tick', 'area', 'line', 'text', 'rule']) {
  const list: Case[] = []
  for (const [xn, x] of NON_MEASURES) {
    for (const [yn, y] of NON_MEASURES) {
      if (x === undefined && y === undefined) continue
      list.push([`x ${xn}, y ${yn}`, { mark, encoding: { ...(x ? { x } : {}), ...(y ? { y } : {}) } }])
    }
  }
  cases(`@aster-charts/vl == vega-lite: a ${mark} over two channels that are not measures`, list)
}

// the orientation asked for, over the same channels
for (const mark of ['bar', 'tick', 'area', 'line']) {
  for (const orient of ['vertical', 'horizontal']) {
    const list: Case[] = []
    for (const [xn, x] of NON_MEASURES) {
      for (const [yn, y] of NON_MEASURES) {
        if (x === undefined && y === undefined) continue
        list.push([`x ${xn}, y ${yn}`, { mark: { type: mark, orient }, encoding: { ...(x ? { x } : {}), ...(y ? { y } : {}) } }])
      }
    }
    cases(`@aster-charts/vl == vega-lite: a ${orient} ${mark} over two channels that are not measures`, list)
  }
}

// --- a line with a second channel (vega-lite makes it a rule) ----------------------------------------------------------------------

const lines: Case[] = []
const KINDS_L: Array<[string, Record<string, unknown>]> = [['measure', q('q')], ['nominal', n('n')], ['temporal', t('t')], ['ordinal', o('o')]]
for (const [xn, x] of KINDS_L) {
  for (const [yn, y] of KINDS_L) {
    lines.push([`x ${xn}, y ${yn}, y2`, { mark: 'line', encoding: { x, y, y2: q('q2') } }])
    lines.push([`x ${xn}, y ${yn}, x2`, { mark: 'line', encoding: { x, y, x2: q('q2') } }])
  }
}
lines.push(
  ['x, x2 and y, y2', { mark: 'line', encoding: { x: q('q'), x2: q('q2'), y: q('q'), y2: q('q2') } }],
  ['with a colour', { mark: 'line', encoding: { x: n('n'), y: q('q'), y2: q('q2'), color: n('n') } }],
  ['with a point overlay', { mark: { type: 'line', point: true }, encoding: { x: n('n'), y: q('q'), y2: q('q2') } }],
  ['with an orient asked', { mark: { type: 'line', orient: 'horizontal' }, encoding: { x: n('n'), y: q('q'), y2: q('q2') } }],
  ['a line with y2 only', { mark: 'line', encoding: { y: q('q'), y2: q('q2') } }],
  ['a line with x2 only', { mark: 'line', encoding: { x: q('q'), x2: q('q2') } }],
  ['a layer of a line with y2 and a point', { layer: [{ mark: 'line', encoding: { x: n('n'), y: q('q'), y2: q('q2') } }, { mark: 'point', encoding: { x: n('n'), y: q('q') } }] }],
)
cases('@aster-charts/vl == vega-lite: a line with a second channel', lines)
