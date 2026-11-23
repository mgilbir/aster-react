/**
 * No encode channel can name the engine's own state on a scene item (audit C1). An encode writes each channel onto the item under
 * its own name, as vega's does; so a channel named like a property the engine keeps on an item for itself (a cached DOM
 * descriptor, a clip, a denial flag, a child list, the item's prototype) would be taken for that state. The engine refuses such a
 * spec when it compiles it (`SpecParseError`). Both halves are derived, not listed by hand:
 *
 *  - the fields of the engine's scene node types (`SceneItem`, `SceneGroup`, `SceneRoot` in core's types.ts, read with the
 *    TypeScript parser) that are neither a channel of vega's JSON schema nor a field vega's own scenegraph, view layout or
 *    captions read off an item (read from vega's builds) must be refused, in a mark's encode, a guide's, a title's and a config
 *    style;
 *  - every name the engine's source mentions (core/src, every identifier after a `.`, before a `:`, in quotes), tried as a channel
 *    of every mark kind, a group, the guides and the title, with hostile values, either is refused, or changes no output at all
 *    (SVG string, DOM descriptors, canvas calls, accessible tree, hit index, image urls), or is a channel vega has (its schema, or
 *    a field vega reads off an item).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildA11yTree, compileChart, evaluateChart, renderSceneToSvg, SpecParseError } from '@aster-charts/core'
import { sceneToDomDesc } from '@aster-charts/core/dom'
import { renderSceneToCanvas, sceneImageUrls, type CanvasLike } from '@aster-charts/core/canvas'
import { buildHitIndex } from '@aster-charts/core/hit'

const here = dirname(fileURLToPath(import.meta.url))
const CORE_SRC = join(here, '../../core/src')
// (vega's own package, as installed: its modules lie beside it)
const vegaDir = realpathSync(join(here, '../node_modules/vega'))
const vegaModule = (name: string, file: string): string => readFileSync(join(vegaDir, '..', name, 'build', file), 'utf8')

/** The channels vega's JSON schema lists for an encode entry. */
const SCHEMA_CHANNELS: ReadonlySet<string> = new Set(Object.keys((JSON.parse(readFileSync(join(vegaDir, 'build/vega-schema.json'), 'utf8')) as {
  definitions: { encodeEntry: { properties: Record<string, unknown> } }
}).definitions.encodeEntry.properties))

/**
 * The fields vega reads off a scene item: in its scenegraph (renderers, bounds, captions), its view layout and its view, every
 * `item.` / `group.` / `scene.` / `mark.` read; and the caption options vega-scale's `domainCaption` reads off the guide item it
 * is handed (`opt.`).
 */
const VEGA_ITEM_READS: ReadonlySet<string> = (() => {
  const names = new Set<string>()
  for (const [mod, file] of [['vega-scenegraph', 'vega-scenegraph.js'], ['vega-view-transforms', 'vega-view-transforms.js'], ['vega-view', 'vega-view.js']]) {
    for (const m of vegaModule(mod!, file!).matchAll(/\b(?:item|group|scene|mark)\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]!)
  }
  const scale = vegaModule('vega-scale', 'vega-scale.js')
  const caption = /function domainCaption\([\s\S]*?\n\}/.exec(scale)![0]
  for (const m of caption.matchAll(/\bopt\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]!)
  return names
})()

/** The fields of the engine's scene node types, read from types.ts. */
function sceneTypeFields(): string[] {
  const src = readFileSync(join(CORE_SRC, 'types.ts'), 'utf8')
  const sf = ts.createSourceFile('types.ts', src, ts.ScriptTarget.Latest, true)
  const out = new Set<string>()
  sf.forEachChild((n) => {
    if (ts.isInterfaceDeclaration(n) && ['SceneItem', 'SceneGroup', 'SceneRoot'].includes(n.name.text)) {
      for (const m of n.members) if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) out.add(m.name.text)
    }
  })
  return [...out]
}

/** Every name the engine's source mentions: after a `.`, before a `:`, in quotes (core/src, tests and test libraries aside). */
function sourceNames(): string[] {
  const names = new Set<string>()
  for (const f of readdirSync(CORE_SRC)) {
    if (!f.endsWith('.ts') || /\.test\.|testlib|testkit/.test(f)) continue
    const s = readFileSync(join(CORE_SRC, f), 'utf8')
    for (const m of s.matchAll(/\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]!)
    for (const m of s.matchAll(/([A-Za-z_$][\w$]*)\??\s*:/g)) names.add(m[1]!)
    for (const m of s.matchAll(/'([A-Za-z_$][\w$]*)'/g)) names.add(m[1]!)
  }
  return [...names]
}

type Spec = Record<string, unknown>
const markSpec = (channel: string, value: unknown): Spec => ({ width: 50, height: 50, marks: [{ type: 'rect', encode: { update: { x: { value: 1 }, [channel]: { value } } } }] })
const where: Record<string, (channel: string, value: unknown) => Spec> = {
  'a mark': markSpec,
  'a group mark': (c, v) => ({ width: 50, height: 50, marks: [{ type: 'group', encode: { update: { [c]: { value: v } } } }] }),
  'an axis': (c, v) => ({ width: 50, height: 50, scales: [{ name: 'x', domain: [0, 1], range: 'width' }], axes: [{ orient: 'bottom', scale: 'x', encode: { labels: { update: { [c]: { value: v } } } } }] }),
  'a title': (c, v) => ({ width: 50, height: 50, title: { text: 'T', encode: { title: { update: { [c]: { value: v } } } } } }),
  'a config style': (c, v) => ({ width: 50, height: 50, config: { style: { s: { [c]: v } } }, marks: [{ type: 'rect', style: 's', encode: { update: { x: { value: 1 } } } }] }),
}

const refused = (spec: Spec): boolean => {
  try { compileChart(spec as never); return false } catch (e) { return e instanceof SpecParseError && /names a property the engine keeps/.test(e.message) }
}

/** Whether a channel of that name ends up on an item of the evaluated scene (an own property, or the item's prototype). */
const reachesItems = (spec: Spec, name: string): boolean => {
  const walk = (nodes: unknown[] | undefined): boolean => (nodes ?? []).some((n) => {
    const o = n as Record<string, unknown>
    return Object.hasOwn(o, name) || Object.getPrototypeOf(o) !== Object.prototype || walk(o.items as unknown[] | undefined)
  })
  return walk(evaluateChart(compileChart(spec as never), {}).items as unknown[])
}

describe('the engine\'s own item state cannot be encoded', () => {
  it('the derivations find what they look for (floors)', () => {
    expect(SCHEMA_CHANNELS.has('fill') && SCHEMA_CHANNELS.has('url')).toBe(true)
    for (const n of ['href', 'fontVariant', 'image', 'noBound', 'translate', 'offset', 'position', 'padding', 'format', 'formatType']) expect(VEGA_ITEM_READS.has(n), n).toBe(true)
    expect(sceneTypeFields().length).toBeGreaterThan(80)
    expect(sourceNames().length).toBeGreaterThan(2000)
  })

  it('every field of the scene types that is not vega\'s is refused, wherever a channel can be given', () => {
    const own = sceneTypeFields().filter((f) => !SCHEMA_CHANNELS.has(f) && !VEGA_ITEM_READS.has(f))
    expect(own.length).toBeGreaterThan(30)
    const open: string[] = []
    for (const f of own) for (const [label, make] of Object.entries(where)) if (!refused(make(f, 1))) open.push(`${f} (${label})`)
    expect(open).toEqual([])
    // and every name in the engine's own namespace (`_`, `__`), the prototype included: refused, or (a config's `__proto__`, which
    // the config merge never copies) never on an item
    for (const f of ['__proto__', '__domDesc', '__gen', '_hit', '_drawError', '_clip', '_part', '_bg', '_kind', '_anything']) {
      for (const [label, make] of Object.entries(where)) {
        const spec = JSON.parse(JSON.stringify(make(f, { fill: 'red' }))) as Spec
        expect(refused(spec) || !reachesItems(spec, f), `${f} (${label})`).toBe(true)
      }
    }
  })

  it('the channels vega has are not refused (control)', () => {
    for (const f of [...SCHEMA_CHANNELS, 'href', 'fontVariant', 'image', 'aCustomChannel']) expect(refused(markSpec(f, 1)), f).toBe(false)
  })

  it('every name the engine reads, as a channel: refused, inert in every output, or a channel vega has', () => {
    const evil = { tag: 'a', attrs: [['onclick', 'x']], items: [{ marktype: 'image', items: [{ url: 'https://evil.test/i.png' }] }], src: 'https://evil.test/s', x: 1, marktype: 'image', role: 'mark' }
    const spec = (channel: string | null): Spec => {
      const ch = (v: unknown): Record<string, unknown> => (channel === null ? {} : { [channel]: { value: v } })
      return {
        width: 100, height: 100, data: [{ name: 't', values: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] }],
        scales: [{ name: 'x', type: 'linear', domain: [0, 3], range: 'width' }, { name: 'c', type: 'ordinal', domain: ['x', 'y'], range: ['red', 'blue'] }],
        axes: [{ orient: 'bottom', scale: 'x', encode: { labels: { update: ch(evil) }, axis: { update: ch('https://evil.test/x') } } }],
        legends: [{ fill: 'c', encode: { symbols: { update: ch('https://evil.test/x') }, legend: { update: ch(evil) } } }],
        title: { text: 'T', encode: { title: { update: ch(evil) }, group: { update: ch('https://evil.test/x') } } },
        marks: [
          { type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { value: 5 }, width: { value: 5 }, height: { value: 5 }, fill: { value: 'red' }, ...ch(evil) } } },
          { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { value: 20 }, fill: { value: 'red' }, ...ch('https://evil.test/x') } } },
          { type: 'text', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { value: 40 }, text: { field: 'b' }, ...ch(evil) } } },
          { type: 'image', encode: { update: { x: { value: 1 }, y: { value: 60 }, width: { value: 5 }, height: { value: 5 }, url: { value: 'https://ok.test/a.png' }, ...ch('https://evil.test/x') } } },
          { type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { value: 70 }, stroke: { value: 'red' }, ...ch(evil) } } },
          { type: 'group', encode: { update: { x: { value: 10 }, y: { value: 80 }, width: { value: 20 }, height: { value: 10 }, fill: { value: 'green' }, ...ch(evil) } },
            marks: [{ type: 'rect', encode: { update: { x: { value: 1 }, y: { value: 1 }, width: { value: 3 }, height: { value: 3 }, fill: { value: 'blue' }, ...ch('https://evil.test/x') } } }] },
        ],
      }
    }
    const outputs = (s: Spec): Record<string, string> => {
      const scene = evaluateChart(compileChart(s as never), {})
      const calls: string[] = []
      const ctx = new Proxy({}, {
        get: (_t, k) => (typeof k !== 'string' ? undefined : k === 'measureText' ? (x: string) => ({ width: String(x).length * 5 }) : k.startsWith('create') ? () => ({ addColorStop() {} }) : (...a: unknown[]) => { calls.push(`${k}(${a.map((x) => (typeof x === 'object' ? 'o' : String(x))).join(',')})`) }),
        set: (_t, k, v) => { calls.push(`${String(k)}=${typeof v === 'object' ? 'o' : String(v)}`); return true },
      }) as unknown as CanvasLike
      renderSceneToCanvas(scene, ctx)
      const hit = buildHitIndex(scene)
      const picks: string[] = []
      for (let x = 0; x < 110; x += 9) for (let y = 0; y < 110; y += 9) { const p = hit.pick(x, y); picks.push(p ? JSON.stringify((p.item as { datum?: unknown }).datum ?? null) : '-') }
      return {
        svg: renderSceneToSvg(scene), dom: JSON.stringify(sceneToDomDesc(scene)), canvas: calls.join(';'), a11y: JSON.stringify(buildA11yTree(scene)),
        hit: picks.join(''), images: JSON.stringify(sceneImageUrls(scene)),
      }
    }
    const base = outputs(spec(null))
    const open: string[] = []
    let inert = 0
    let refusedN = 0
    for (const name of sourceNames()) {
      if (SCHEMA_CHANNELS.has(name) || VEGA_ITEM_READS.has(name)) continue
      if (refused(spec(name))) { refusedN++; continue }
      let got: Record<string, string>
      try { got = outputs(spec(name)) } catch (e) { open.push(`${name}: throws ${String(e)}`); continue }
      const differ = Object.keys(base).filter((k) => got[k] !== base[k])
      if (differ.length) open.push(`${name}: changes ${differ.join(', ')}`)
      else inert++
    }
    expect(open).toEqual([])
    // (the scan tried names of both kinds: it is not vacuous)
    expect(refusedN).toBeGreaterThan(40)
    expect(inert).toBeGreaterThan(1000)
  }, 300_000)
})
