/**
 * A title, as vega-parser builds it (parsers/title.js: a group holding the title text and the subtitle) and
 * vega-view-transforms lays it out (layout/title.js): the group is placed by its `orient`, `anchor` and `offset`
 * against the bounds of the view, the subtitle under (or beside) the title. See guide-encode.ts for how a property
 * reaches an item.
 */
import type { SceneItem } from './types.js'
import { Bounds, boundLeaf } from './bounds.js'
import {
  addEncoders, encodeItem, extendEncode, guideMark, lookup, one, zero,
  type Entry, type EntryHost, type GuideMarkDef, type GuideStyles, type MarkEncode, type Row, type UserEncode,
} from './guide-encode.js'

type Rec = Record<string, unknown>

const alignExpr: Entry = (s) => (s.item.anchor === 'start' ? 'left' : s.item.anchor === 'end' ? 'right' : 'center')
const angleExpr: Entry = (s) => (s.item.orient === 'left' ? -90 : s.item.orient === 'right' ? 90 : 0)

export interface TitleBuildInput {
  /** the title spec (a string title is `{text}`) */
  spec: Rec
  /** `config.title` */
  cfg: Rec
  /** the bounds of the view the title sits against (the content, the axes, the legends) */
  viewBounds: Bounds
  width: number
  height: number
  /** the layout never ran: the group and the subtitle stay at their encode positions */
  raw: boolean
  host: EntryHost
  style: GuideStyles
}

export interface TitleBuilt {
  group: Rec
  title: SceneItem & Rec
  subtitle?: SceneItem & Rec
  partMeta: Record<string, { name?: string; interactive: boolean }>
}

function textMark(
  role: string, style: string, text: unknown, props: Rec, updateProps: Rec, user: UserEncode | undefined,
): GuideMarkDef {
  const encode: MarkEncode = { enter: { opacity: zero }, update: { opacity: one }, exit: { opacity: zero } }
  addEncoders(encode, {
    text,
    align: ((s) => s.group.align) as Entry,
    angle: ((s) => s.group.angle) as Entry,
    limit: ((s) => s.group.limit) as Entry,
    baseline: 'top',
    ...props,
  }, updateProps)
  return guideMark({ type: 'text', role, style, encode, interactive: false }, user)
}

/** Build a title from vega-parser's title.js, evaluate it, lay it out. */
export function buildTitle(inp: TitleBuildInput): TitleBuilt {
  const { spec, host, style } = inp
  const _ = lookup(spec, inp.cfg)
  const encode = (spec.encode ?? {}) as Record<string, UserEncode | undefined>
  const userEncode = (encode.group ?? {}) as UserEncode

  // the group item
  const g: MarkEncode = { enter: {}, update: {} }
  addEncoders(g, {
    orient: _('orient'), anchor: _('anchor'), align: alignExpr, angle: angleExpr, limit: _('limit'), frame: _('frame'),
    offset: _('offset') || 0, padding: _('subtitlePadding'),
  })
  extendEncode(g, userEncode, true)
  const datum: Row = {}
  const group = encodeItem({ type: 'rule', role: 'title', style: userEncode.style, encode: g, interactive: false }, datum, {}, host, style) as unknown as Rec

  // titleEncode(): the title text's own encode is `encode.title`, else the deprecated top-level encode block
  const titleUser: UserEncode | undefined = (encode.title as UserEncode | undefined)
    ?? ({ name: spec.name, interactive: spec.interactive, style: spec.style, ...(encode as unknown as Rec) } as UserEncode)
  const titleDef = textMark('title-text', 'group-title', spec.text, {
    dx: _('dx'), dy: _('dy'), fill: _('color'), font: _('font'), fontSize: _('fontSize'), fontStyle: _('fontStyle'),
    fontWeight: _('fontWeight'), lineHeight: _('lineHeight'),
  }, { align: _('align'), angle: _('angle'), baseline: _('baseline') }, titleUser)
  const title = encodeItem(titleDef, datum, group, host, style) as SceneItem & Rec
  title._kind = 'text'
  const partMeta: TitleBuilt['partMeta'] = {
    title: { name: titleDef.name, interactive: titleDef.interactive },
    group: { name: userEncode.name == null || userEncode.name === '' ? undefined : String(userEncode.name), interactive: !!userEncode.interactive },
  }
  let subtitle: (SceneItem & Rec) | undefined
  if (spec.subtitle) {
    const subDef = textMark('title-subtitle', 'group-subtitle', spec.subtitle, {
      dx: _('dx'), dy: _('dy'), fill: _('subtitleColor'), font: _('subtitleFont'), fontSize: _('subtitleFontSize'),
      fontStyle: _('subtitleFontStyle'), fontWeight: _('subtitleFontWeight'), lineHeight: _('subtitleLineHeight'),
    }, { align: _('align'), angle: _('angle'), baseline: _('baseline') }, encode.subtitle)
    subtitle = encodeItem(subDef, datum, group, host, style) as SceneItem & Rec
    subtitle._kind = 'text'
    partMeta.subtitle = { name: subDef.name, interactive: subDef.interactive }
  }

  // --- titleLayout (vega-view-transforms layout/title.js) ---
  if (!inp.raw) {
    const orient = group.orient as string
    const anchor = group.anchor as string
    const offset = group.offset as number
    const padding = group.padding as number
    const frame = group.frame as string
    const vb = inp.viewBounds
    const titleB = boundLeaf(new Bounds(), title)
    let end = orient === 'left' || orient === 'right' ? inp.height : inp.width
    let start = 0
    if (frame !== 'group') {
      if (orient === 'left') { start = vb.y2; end = vb.y1 }
      else if (orient === 'right') { start = vb.y1; end = vb.y2 }
      else { start = vb.x1; end = vb.x2 }
    } else if (orient === 'left') {
      start = inp.height; end = 0
    }
    const pos = anchor === 'start' ? start : anchor === 'end' ? end : (start + end) / 2
    let sx = 0
    let sy = 0
    const temp = new Bounds()
    if (subtitle && subtitle.text) {
      // position subtitle
      switch (orient) {
        case 'top':
        case 'bottom': sy = titleB.height() + padding; break
        case 'left': sx = titleB.width() + padding; break
        case 'right': sx = -titleB.width() - padding; break
      }
      // the subtitle's bounds are the old ones moved by the difference (vega translates them: a NaN offset poisons them)
      const moved = boundLeaf(new Bounds(), subtitle).translate(sx - ((subtitle.x as number) || 0), sy - ((subtitle.y as number) || 0))
      const changed = (subtitle.x === sx ? 0 : 1) | (subtitle.y === sy ? 0 : 1)
      subtitle.x = sx
      subtitle.y = sy
      temp.union(changed ? moved : boundLeaf(new Bounds(), subtitle))
    }
    temp.union(titleB)
    let x = 0
    let y = 0
    switch (orient) {
      case 'top': x = pos; y = vb.y1 - temp.height() - offset; break
      case 'left': x = vb.x1 - temp.width() - offset; y = pos; break
      case 'right': x = vb.x2 + temp.width() + offset; y = pos; break
      case 'bottom': x = pos; y = vb.y2 + offset; break
      default: x = group.x as number; y = group.y as number
    }
    group.x = x
    group.y = y
  }
  return { group, title, subtitle, partMeta }
}
