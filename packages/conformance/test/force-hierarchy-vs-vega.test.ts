// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { agree, asterDatasets, forceCase, gen, hierarchySpec, SCHEMA, vegaDatasets } from './force-hierarchy-gen.js'

describe('force: every force and parameter combination, bit for bit against vega', () => {
  const N = 220
  it.each(Array.from({ length: N }, (_, i) => i))('case %i', async (i) => { await agree(forceCase(1000 + i), `force seed ${1000 + i}`) }, 60_000)

  // bigger graphs, and many bodies on the same few points (a leaf of the quadtree then chains bodies)
  it.each([['spread', 150], ['clumped', 90]] as const)('%s: %i nodes under every force', async (kind, n) => {
    const g = gen(31)
    const nodes = Array.from({ length: n }, (_, i) => ({ id: i, w: g.int(1, 6), ...(kind === 'clumped' ? { x: g.pick([5, 5, 40]), y: g.pick([5, 40]) } : {}) }))
    const links = Array.from({ length: 2 * n }, () => ({ source: g.int(0, n - 1), target: g.int(0, n - 1) }))
    const forces = [{ force: 'center', x: 100, y: 100 }, { force: 'collide', radius: { expr: 'datum.w * 2' }, iterations: 2 }, { force: 'nbody', strength: -25, distanceMax: 300 }, { force: 'link', links: 'links', distance: 20 }, { force: 'x', x: 'w', strength: 0.02 }]
    const spec = { $schema: SCHEMA, width: 10, height: 10, data: [{ name: 'nodes', values: nodes }, { name: 'links', values: links }, { name: 'out', source: 'nodes', transform: [{ type: 'force', static: true, iterations: 200, forces }] }] }
    await agree(spec, `${kind} force graph`)
  }, 60_000)

  // an unknown node in a link: the same error as d3-force
  it('a link to a node that does not exist', async () => {
    const spec = { $schema: SCHEMA, width: 10, height: 10, data: [
      { name: 'nodes', values: [{ id: 'a' }, { id: 'b' }] }, { name: 'links', values: [{ source: 'a', target: 'zz' }] },
      { name: 'out', source: 'nodes', transform: [{ type: 'force', static: true, forces: [{ force: 'link', links: 'links', id: 'id' }] }] }] }
    const v = await vegaDatasets(spec)
    expect(v.errors.length).toBeGreaterThan(0)
    expect(asterDatasets(spec).errors).toEqual(v.errors)
  })
})

describe('hierarchy layouts: every layout, tiling method, padding, round, size and sort, bit for bit against vega', () => {
  const N = 400
  it.each(Array.from({ length: N }, (_, i) => i))('case %i', async (i) => { await agree(hierarchySpec(5000 + i), `hierarchy seed ${5000 + i}`) }, 60_000)

  // every tiling method on the same big tree, with and without the optional parameters
  const METHODS = ['squarify', 'resquarify', 'binary', 'slice', 'dice', 'slicedice']
  it.each(METHODS)('treemap %s on a large tree with nested padding', async (method) => {
    const g = gen(77)
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: 'n' + i, parent: i ? 'n' + g.int(0, i - 1) : null, v: g.num(0, 10) }))
    for (const extra of [{}, { ratio: 2 }, { padding: 3, round: true }, { paddingInner: 2, paddingTop: 12, paddingOuter: 1 }]) {
      const spec = { $schema: SCHEMA, width: 100, height: 100, data: [{ name: 'src', values: rows }, { name: 'out', source: 'src', transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }, { type: 'treemap', method, field: 'v', size: [640, 480], sort: { field: 'value', order: 'descending' }, ...extra }] }] }
      await agree(spec, `treemap ${method} ${JSON.stringify(extra)}`)
    }
  })

  // sizes the small generated trees do not reach: a packer walk long enough to be cut off by a total step budget, deep
  // chains, wide fans
  const bigTree = (seed: number, n: number, shape: 'fan' | 'random' | 'deep') => {
    const g = gen(seed)
    return Array.from({ length: n }, (_, i) => ({ id: 'n' + i, parent: i ? 'n' + (shape === 'fan' ? 0 : shape === 'deep' ? i - 1 : g.int(0, i - 1)) : null, v: g.num(0.1, 5) }))
  }
  it.each([['fan', 1500], ['random', 1500], ['deep', 600]] as const)('every layout on a large %s tree of %i rows', async (shape, n) => {
    const rows = bigTree(9, n, shape)
    for (const layout of [{ type: 'pack', field: 'v', size: [500, 500], padding: 1 }, { type: 'treemap', field: 'v', size: [640, 480] }, { type: 'partition', field: 'v', size: [640, 480], round: true }, { type: 'tree', method: 'tidy', size: [300, 200] }, { type: 'tree', method: 'cluster', nodeSize: [4, 9] }]) {
      const spec = { $schema: SCHEMA, width: 100, height: 100, data: [{ name: 'src', values: rows }, { name: 'out', source: 'src', transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }, layout] }] }
      await agree(spec, `${layout.type} on a ${shape} tree`)
    }
  }, 60_000)

  // equal values and equal radii make every comparison a tie: which side of the packing front is walked first, where a
  // binary tiling splits, how a row ends
  it.each([2, 3, 4, 5, 6, 7, 8, 9, 12, 16, 33])('every layout on a root with %i equal children, and on a tree of equal values', async (n) => {
    const flat = Array.from({ length: n + 1 }, (_, i) => ({ id: 'n' + i, parent: i ? 'n0' : null, v: 1 }))
    const nested = Array.from({ length: 3 * n + 1 }, (_, i) => ({ id: 'n' + i, parent: i === 0 ? null : i <= n ? 'n0' : 'n' + (1 + (i - n - 1) % n), v: 1 }))
    const layouts: Array<Record<string, unknown>> = [
      { type: 'pack', field: 'v' }, { type: 'pack', field: 'v', padding: 2, size: [300, 200] }, { type: 'pack', radius: 'data.v', size: [100, 100] },
      ...['squarify', 'resquarify', 'binary', 'slice', 'dice', 'slicedice'].map((method) => ({ type: 'treemap', method, field: 'v', size: [400, 300] })),
      { type: 'treemap', method: 'binary', field: 'v', size: [100, 400], paddingInner: 1 },
      { type: 'tree', method: 'tidy', size: [100, 100] }, { type: 'tree', method: 'cluster', size: [100, 100] }, { type: 'partition', field: 'v', size: [100, 100] },
    ]
    for (const rows of [flat, nested]) {
      for (const layout of layouts) {
        const spec = { $schema: SCHEMA, width: 100, height: 100, data: [{ name: 'src', values: rows }, { name: 'out', source: 'src', transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }, layout] }] }
        await agree(spec, `${JSON.stringify(layout)} on ${rows.length} equal rows`)
      }
    }
  }, 60_000)
})
