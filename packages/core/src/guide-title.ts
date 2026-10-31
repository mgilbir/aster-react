/**
 * A title: a group item holding the title text and, optionally, a subtitle, placed against the bounds of the view by its `orient`,
 * `anchor`, `frame` and `offset`, with the subtitle beside or below the title. See guide-encode.ts for how a property becomes a
 * channel of an item.
 */
import type { SceneItem } from './types.js'
import { Bounds, boundLeaf } from './bounds.js'
import {
  ONE, ZERO, customize, encodeItem, mergeUserEncode, propsOf, setChannels,
  type Entry, type EntryHost, type GuideMarkDef, type GuideProps, type GuideStyles, type MarkEncode, type Row, type UserEncode,
} from './guide-encode.js'

type Rec = Record<string, unknown>

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

/** A title reads as text along the edge it sits on: turned a quarter to face outward on the left and right. */
const turnFor = (orient: unknown): number => (orient === 'left' ? -90 : orient === 'right' ? 90 : 0)
const textAlignFor = (anchor: unknown): string => (anchor === 'start' ? 'left' : anchor === 'end' ? 'right' : 'center')

/**
 * The title text or the subtitle. Both take their alignment, angle and line limit from the group, and differ in the style they
 * start from and in the properties (`color`, `fontSize` ... or `subtitleColor`, `subtitleFontSize` ...) that style them.
 */
function textPart(props: GuideProps, subtitle: boolean, text: unknown, user: UserEncode | undefined): GuideMarkDef {
  const prop = (name: string): unknown => props.get(subtitle ? 'subtitle' + name[0]!.toUpperCase() + name.slice(1) : name)
  const encode: MarkEncode = { enter: { opacity: ZERO }, update: { opacity: ONE }, exit: { opacity: ZERO } }
  setChannels(encode, {
    text,
    align: ((s) => s.group.align) as Entry,
    angle: ((s) => s.group.angle) as Entry,
    limit: ((s) => s.group.limit) as Entry,
    baseline: 'top',
    dx: props.get('dx'), dy: props.get('dy'),
    fill: prop('color'), font: prop('font'), fontSize: prop('fontSize'), fontStyle: prop('fontStyle'),
    fontWeight: prop('fontWeight'), lineHeight: prop('lineHeight'),
  }, { align: props.get('align'), angle: props.get('angle'), baseline: props.get('baseline') })
  return customize(
    { type: 'text', role: subtitle ? 'title-subtitle' : 'title-text', style: subtitle ? 'group-subtitle' : 'group-title', encode, interactive: false },
    user,
  )
}

export function buildTitle(inp: TitleBuildInput): TitleBuilt {
  const { spec, host, style } = inp
  const props = propsOf(spec, inp.cfg)
  const userEncode = (spec.encode ?? {}) as Record<string, UserEncode | undefined>
  const groupUser = (userEncode.group ?? {}) as UserEncode

  // the group item: where the title goes, and the text's alignment and limit that follow from it
  const groupEncode: MarkEncode = { enter: {}, update: {} }
  setChannels(groupEncode, {
    orient: props.get('orient'), anchor: props.get('anchor'),
    align: ((s) => textAlignFor(s.item.anchor)) as Entry,
    angle: ((s) => turnFor(s.item.orient)) as Entry,
    limit: props.get('limit'), frame: props.get('frame'), offset: props.get('offset') || 0, padding: props.get('subtitlePadding'),
  })
  mergeUserEncode(groupEncode, groupUser)
  const datum: Row = {}
  const group = encodeItem({ type: 'rule', role: 'title', style: groupUser.style, encode: groupEncode, interactive: false }, datum, {}, host, style) as unknown as Rec

  // the text is styled by `encode.title`; a spec that still puts its blocks at the top of `encode` styles it from there
  const textUser: UserEncode | undefined = userEncode.title
    ?? ({ name: spec.name, interactive: spec.interactive, style: spec.style, ...(userEncode as unknown as Rec) } as UserEncode)
  const titleDef = textPart(props, false, spec.text, textUser)
  const title = encodeItem(titleDef, datum, group, host, style) as SceneItem & Rec
  title._kind = 'text'
  const partMeta: TitleBuilt['partMeta'] = {
    title: { name: titleDef.name, interactive: titleDef.interactive },
    group: { name: groupUser.name == null || groupUser.name === '' ? undefined : String(groupUser.name), interactive: !!groupUser.interactive },
  }
  let subtitle: (SceneItem & Rec) | undefined
  if (spec.subtitle) {
    const subtitleDef = textPart(props, true, spec.subtitle, userEncode.subtitle)
    subtitle = encodeItem(subtitleDef, datum, group, host, style) as SceneItem & Rec
    subtitle._kind = 'text'
    partMeta.subtitle = { name: subtitleDef.name, interactive: subtitleDef.interactive }
  }
  if (!inp.raw) placeTitle(group, title, subtitle, inp.viewBounds, inp.width, inp.height)
  return { group, title, subtitle, partMeta }
}

/**
 * Put the title group against the view: at its anchor along the edge it is on, outside the bounds of the view (or the frame of the
 * view's group) by `offset`, clear of the subtitle, which goes below the title on a horizontal edge and beside it on a vertical one.
 */
function placeTitle(group: Rec, title: SceneItem, subtitle: (SceneItem & Rec) | undefined, view: Bounds, width: number, height: number): void {
  const orient = group.orient as string
  const anchor = group.anchor as string
  const offset = group.offset as number
  const padding = group.padding as number
  const vertical = orient === 'left' || orient === 'right'

  // the stretch of the edge the anchor picks a point on
  let start = 0
  let end = vertical ? height : width
  if (group.frame !== 'group') {
    if (orient === 'left') [start, end] = [view.y2, view.y1]
    else if (orient === 'right') [start, end] = [view.y1, view.y2]
    else [start, end] = [view.x1, view.x2]
  } else if (orient === 'left') {
    [start, end] = [height, 0]
  }
  const pos = anchor === 'start' ? start : anchor === 'end' ? end : (start + end) / 2

  const titleBox = boundLeaf(new Bounds(), title)
  const taken = new Bounds()
  if (subtitle && subtitle.text) {
    const sx = orient === 'left' ? titleBox.width() + padding : orient === 'right' ? -titleBox.width() - padding : 0
    const sy = orient === 'top' || orient === 'bottom' ? titleBox.height() + padding : 0
    // its bounds are the old ones moved by the difference (a NaN offset poisons them), unless it did not move
    const moved = boundLeaf(new Bounds(), subtitle).translate(sx - ((subtitle.x as number) || 0), sy - ((subtitle.y as number) || 0))
    const stayed = subtitle.x === sx && subtitle.y === sy
    subtitle.x = sx
    subtitle.y = sy
    taken.union(stayed ? boundLeaf(new Bounds(), subtitle) : moved)
  }
  taken.union(titleBox)

  switch (orient) {
    case 'top':
      group.x = pos
      group.y = view.y1 - taken.height() - offset
      break
    case 'left':
      group.x = view.x1 - taken.width() - offset
      group.y = pos
      break
    case 'right':
      group.x = view.x2 + taken.width() + offset
      group.y = pos
      break
    case 'bottom':
      group.x = pos
      group.y = view.y2 + offset
      break
    default:
      // no known edge: the group stays where its encode put it
      break
  }
}
