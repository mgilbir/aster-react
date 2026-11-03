/**
 * The title of a guide that more than one field stands behind: a ranged channel (x and x2, y and y2) and the layers that share an
 * axis. A guide's title is either text somebody wrote (a `title` on a channel, or on the axis) or, when nobody did, the default
 * titles of the fields it shows. Combining two of them follows one rule set, so a field shown twice is named once:
 *
 *  - two pieces of text join with ", ", unless they are the same text;
 *  - a title written as `null` switches the guide's title off, whatever the other says;
 *  - written text wins over the titles of fields;
 *  - two lists of fields join, leaving out a field that is already in the list.
 */

/** Text a user wrote as a title: a string, or the lines of one. `null` and the empty text mean "no title". */
export type TitleText = string | string[]

/** What a guide's title is made of, before it becomes text. */
export type GuideTitle =
  | { readonly kind: 'text'; readonly text: TitleText | null | undefined }
  | { readonly kind: 'fields'; readonly fields: readonly TitledField[] }

/** A field a default title is made from, with the identity that tells it from another (field, aggregate, bin, time unit). */
export interface TitledField {
  readonly key: string
  readonly title: string
}

const isText = (v: unknown): v is TitleText => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
const lines = (t: TitleText): string[] => (Array.isArray(t) ? t : [t])
const sameText = (a: TitleText, b: TitleText): boolean => (typeof a === 'string' && typeof b === 'string' ? a === b : JSON.stringify(a) === JSON.stringify(b))

/** Two pieces of title text as one: the same text stays, an empty second is dropped, otherwise they join with ", ". */
export function joinTitleText(a: TitleText, b: TitleText): TitleText {
  if (sameText(a, b) || !b) return a
  if (!a) return b
  return [...lines(a), ...lines(b)].join(', ')
}

/** The title a channel and its second channel write between them, if either wrote one (a switched-off title counts as written). */
export function writtenTitle(first: unknown, second: unknown): { text: TitleText | null | undefined } | undefined {
  if (first && second && isText(first) && isText(second)) return { text: joinTitleText(first, second) }
  if (first) return { text: first as TitleText }
  if (second) return { text: second as TitleText }
  if (first !== undefined) return { text: first as TitleText | null }
  if (second !== undefined) return { text: second as TitleText | null }
  return undefined
}

/** The fields of a guide as one title: each field once, in order. */
export function fieldsTitle(...fields: TitledField[]): GuideTitle {
  const kept: TitledField[] = []
  for (const f of fields) if (!kept.some((k) => k.key === f.key)) kept.push(f)
  return { kind: 'fields', fields: kept }
}

/** The title of one guide where two views of it meet (layers on the same axis). */
export function mergeGuideTitles(a: GuideTitle, b: GuideTitle): GuideTitle {
  const aText = a.kind === 'text' ? a.text : undefined
  const bText = b.kind === 'text' ? b.text : undefined
  // a title that is switched off, or was never set, ends the guide's title
  if (a.kind === 'text' && (aText === null || aText === undefined)) return { kind: 'text', text: null }
  if (b.kind === 'text' && bText === null) return { kind: 'text', text: null }
  if (a.kind === 'text' && b.kind === 'text') {
    return { kind: 'text', text: isText(aText) && isText(bText) ? joinTitleText(aText, bText) : aText }
  }
  if (a.kind === 'text') return a
  if (b.kind === 'text') return b
  return fieldsTitle(...a.fields, ...b.fields)
}

/** The text of a guide's title, or `undefined` when it has none. */
export function titleText(t: GuideTitle): TitleText | undefined {
  const text = t.kind === 'text' ? t.text : t.fields.map((f) => f.title).join(', ')
  return text === null || text === undefined || text === '' ? undefined : text
}
