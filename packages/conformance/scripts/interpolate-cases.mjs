/**
 * Interpolator oracle cases for the table `vega-scale`'s `interpolate(type, gamma)` reads
 * (the d3-interpolate namespace): each case builds `interpolate(name, gamma)(...args)` and
 * evaluates it at the `T` positions. Consumed by `differential-interpolate.test.mts`.
 */

export const T = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, -0.2, 1.3, 0.333333]
const colors = [['#ff0000', '#0000ff'], ['#ffffe0', '#8b0000'], ['steelblue', 'orange'], ['#808080', '#00ff00'], ['white', 'black'], ['rgba(255,0,0,0.5)', 'rgba(0,0,255,1)'], ['#ff0000', 'nonsense'], ['gray', 'gray'], ['hsl(10,50%,50%)', 'hsl(200,80%,30%)']]
const palettes = [['#ffffe0', '#6a9', '#8b0000'], ['red', 'green', 'blue', 'yellow'], ['#fff', '#000'], ['#123', '#456', '#789', '#abc', '#def']]
const nums = [[0, 10], [10, 0], [-5, 5], [3, 3], [1e6, 1e-6]]

export const cases = []
const add = (name, gamma, args) => cases.push({ name, gamma, args })
for (const n of ['rgb', 'hsl', 'hsl-long', 'lab', 'hcl', 'hcl-long', 'cubehelix', 'cubehelix-long']) {
  for (const pair of colors) add(n, undefined, pair)
  for (const g of [0.5, 1, 2.2]) for (const pair of colors.slice(0, 4)) add(n, g, pair)
}
for (const n of ['rgb-basis', 'rgb-basis-closed']) for (const p of palettes) add(n, undefined, [p])
for (const n of ['basis', 'basis-closed']) for (const p of [[0, 10, 5, 20], [1, 2], [4, 4, 4], [0, 100, 0, 100, 0]]) add(n, undefined, [p])
for (const p of palettes) add('discrete', undefined, [p])
for (const n of ['hue', 'number', 'round']) for (const p of [...nums, [350, 10], [10, 350], [0, 360], [NaN, 120], [120, NaN]]) add(n, undefined, p)
for (const p of [[[0, 0, 100], [100, 100, 200]], [[10, 10, 50], [10, 10, 400]], [[0, 0, 1], [3, 4, 5]]]) add('zoom', undefined, p)
add('string', undefined, ['a1b22c', 'a5b3c'])
add('string', undefined, ['rgb(0,0,0)', 'rgb(255,100,50)'])
add('date', undefined, [new Date(0), new Date(1e12)])
add('array', undefined, [[0, 10, 20], [10, 0, 5]])
add('number-array', undefined, [[0, 10], [10, 20]])
add('object', undefined, [{ a: 0, b: 'x' }, { a: 10, b: 'y' }])
add('', undefined, [0, 10])
add('', undefined, ['#ff0000', '#0000ff'])
add('', undefined, [[1, 2], [3, 4]])
add('bogus', undefined, [0, 1])

