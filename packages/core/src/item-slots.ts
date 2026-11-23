/**
 * Which names an encode channel may take. An encode writes each of its channels onto the scene item under the channel's own name
 * (vega's encoders do the same), so a channel named like a property the engine keeps on an item for itself would be taken for the
 * engine's own state: a cached DOM descriptor, an item's link-denial flag, a clip, a group's child list, the item's prototype
 * (`__proto__`). Those names are the engine's: a spec (its encode blocks, its `config` styles and mark defaults) that names one
 * is refused when it is compiled (`SpecParseError`), never drawn.
 *
 * The engine's names are every name that starts with `_` (every private slot is so named), and the fields of the scene node
 * types (`SceneItem`, `SceneGroup`, `SceneRoot` in types.ts) that are not item fields of vega's own: what the engine writes on a
 * node for its renderers, its hit index, its accessible tree and its reuse machinery. `item-slots.test.ts` derives both lists
 * from their sources -- the type declarations, and every name the engine's source reads, tried as a channel against every
 * renderer -- and fails on a name that changes any output and is neither vega's nor refused here.
 */

/**
 * The item fields vega's scenegraph and view read that its JSON schema's `encodeEntry` does not list. They are channels a vega
 * spec may encode, so they are not the engine's:
 * - `href` (vega-scenegraph: an item with one is drawn in a link), `fontVariant` (the text font), `image` (the image mark's bitmap,
 *   which vega's image loader sets from `url`; a spec may give one);
 * - `noBound` (vega-scenegraph `boundItem`: a group item that says so is left out of its bounds);
 * - a guide group item's `offset`, `position`, `translate`, `padding` (vega-view-transforms' axis and legend layout) and
 *   `format`, `formatType` (vega-scenegraph's guide captions).
 */
export const VEGA_ITEM_FIELDS: ReadonlySet<string> = new Set([
  'href', 'fontVariant', 'image', 'noBound', 'offset', 'position', 'translate', 'padding', 'format', 'formatType',
])

/**
 * The fields of the engine's scene nodes that are its own (types.ts, and the two flags written beside them): never a channel.
 * The vega item fields (`x`, `fill`, `href`, ... and {@link VEGA_ITEM_FIELDS}) are not in it, nor the names starting with `_`,
 * which {@link isEngineSlot} refuses by their prefix.
 */
export const ENGINE_ITEM_SLOTS: ReadonlySet<string> = new Set([
  // SceneItem
  'mark', 'datum',
  // SceneGroup
  'marktype', 'name', 'role', 'items', 'hasLinks', 'markClip', 'unbounded', 'clipPathD', 'parts', 'partMeta', 'unmeasuredFrom',
  'box', 'boxFg', 'scopeSignals', 'markIndex', 'emptyMark', 'interactive', 'describes', 'itemAria', 'cssName', 'markRole',
  'contentClip', 'scale', 'title', 'legendType', 'madeMarks', 'legendScale', 'legendChannels',
  // SceneRoot
  'plotWidth', 'plotHeight', 'frameX', 'frameY', 'frameAria', 'runtime', 'compiled', 'background', 'frameStroke', 'frameFill',
  'frameFillTransparent', 'frameStrokeWidth', 'frameFillOpacity', 'frameOpacity', 'frameStrokeDash', 'frameCornerRadius',
  'frameClip', 'frameStrokeOpacity', 'frameStrokeMiterLimit', 'frameStrokeDashOffset', 'frameStrokeCap', 'frameStrokeJoin',
  'defs', 'signalParams',
  // written on items beside the typed fields: the datum stamped for the DOM (`data-datum`), an image or link the URL policy refused
  'dataDatum', 'urlDenied',
])

/** Whether a channel name is the engine's (see the module comment): a name that starts with `_`, or one of {@link ENGINE_ITEM_SLOTS}. */
export function isEngineSlot(name: string): boolean {
  return name.charCodeAt(0) === 95 /* _ */ || ENGINE_ITEM_SLOTS.has(name)
}

/** The message a spec that names an engine slot as a channel is refused with. */
export function engineSlotMessage(name: string, where: string): string {
  return `Encode channel "${name}" (${where}) names a property the engine keeps on its scene items for itself; it cannot be encoded.`
}
