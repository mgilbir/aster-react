import { describe, expect, it } from 'vitest'
import { resolveCursor } from './cursor.js'
import { createCursorTracker } from './signals.js'
import { buildHitIndex } from './hit.js'
import type { SceneRoot } from './types.js'

describe('resolveCursor (vega-view cursor.js: user && user !== "default" ? user : (item || user))', () => {
  it.each([
    [undefined, null, 'default'],
    ['default', null, 'default'],
    ['default', 'pointer', 'pointer'],
    ['wait', 'pointer', 'wait'],
    ['wait', null, 'wait'],
    ['', 'pointer', 'pointer'],
    ['', null, null],
    [null, 'pointer', 'pointer'],
    [{ user: 'default', item: 'grab' }, 'pointer', 'grab'],
    [{ user: 'move', item: 'grab' }, null, 'move'],
    [{ user: 'default', item: null }, 'pointer', 'default'],
  ])('signal %j with item %j shows %j', (signal, item, shown) => {
    expect(resolveCursor(signal, item as string | null)).toBe(shown)
  })
})

describe('createCursorTracker', () => {
  const picks = (cursor: string | undefined) => (x: number) => (x < 10 ? { item: { cursor } } : null)

  it('reports only changes, resets off the items, and lets the user signal win', () => {
    const seen: Array<string | null> = []
    let user: unknown = undefined
    const t = createCursorTracker({ pick: picks('pointer'), user: () => user, onCursor: (c) => seen.push(c) })
    t.move(5, 0); t.move(6, 0); t.move(50, 0); t.move(60, 0)
    expect(seen).toEqual(['pointer', 'default'])
    user = 'wait'; t.refresh(); t.move(5, 0); t.move(50, 0)
    expect(seen).toEqual(['pointer', 'default', 'wait'])
    user = 'default'; t.move(5, 0); t.refresh()
    expect(seen).toEqual(['pointer', 'default', 'wait', 'pointer'])
  })

  it('an item without a cursor shows the default', () => {
    const seen: Array<string | null> = []
    const t = createCursorTracker({ pick: picks(undefined), user: () => undefined, onCursor: (c) => seen.push(c) })
    t.move(5, 0)
    expect(seen).toEqual([])
  })

  it('config.events.view that blocks pointermove stops it', () => {
    for (const [view, blocked] of [[false, true], [['click'], true], [['pointermove'], false], [{ click: true }, true], [undefined, false]] as const) {
      const seen: Array<string | null> = []
      createCursorTracker({ pick: picks('pointer'), user: () => undefined, onCursor: (c) => seen.push(c), eventConfig: { view } }).move(5, 0)
      expect(seen.length === 0, JSON.stringify(view)).toBe(blocked)
    }
  })
})

describe('HitIndex.pick', () => {
  const legend = (interactive: boolean): SceneRoot => ({
    width: 100, height: 60,
    items: [
      { marktype: 'rect', interactive: false, items: [{ x: 0, y: 0, width: 50, height: 50, fill: '#ccc', cursor: 'wait', datum: { v: 1 } }] },
      { marktype: 'rect', items: [{ x: 50, y: 0, width: 40, height: 40, fill: '#ccc', cursor: 'pointer', datum: { v: 2 } }] },
      {
        marktype: 'group', role: 'legend', x: 0, y: 50, partMeta: { entries: { interactive }, symbol: { interactive } },
        items: [{ path: 'M0,0h20v10h-20Z', x: 0, y: 0, _bg: true, fill: 'transparent', cursor: 'copy', _part: 'entry', _hit: true }],
      },
    ],
  } as unknown as SceneRoot)

  it('looks through a mark with interactive false, and finds the item below or nothing', () => {
    const idx = buildHitIndex(legend(true))
    expect(idx.query(10, 10)?.item.datum).toEqual({ v: 1 })
    expect(idx.pick(10, 10)).toBeNull()
    expect((idx.pick(60, 10)?.item as { cursor?: string }).cursor).toBe('pointer')
  })

  it('finds an interactive guide part the other queries do not see, and no other', () => {
    const on = buildHitIndex(legend(true))
    expect((on.pick(5, 55)?.item as { cursor?: string }).cursor).toBe('copy')
    expect(on.query(5, 55)).toBeNull()
    expect(on.queryMark(5, 55)).toBeNull()
    expect(buildHitIndex(legend(false)).pick(5, 55)).toBeNull()
  })
})
