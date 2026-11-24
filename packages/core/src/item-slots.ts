/**
 * Which names an encode channel may take. An encode writes each of its channels onto the scene item under the channel's own name
 * (vega's encoders do the same), so a channel named like a property the engine keeps on an item for itself would be taken for the
 * engine's own state: a cached DOM descriptor, an item's link-denial flag, a clip, a group's child list, the item's prototype
 * (`__proto__`). Those names are the engine's: a spec (its encode blocks, its `config` styles and mark defaults) that names one
 * is refused when it is compiled (`SpecParseError`), never drawn.
 *
 * The engine's names are every name that starts with `_` (every private slot is so named), and the fields of the scene node
 * types (`SceneItem`, `SceneGroup`, `SceneRoot` in types.ts) that are not item fields of vega's own: what the engine writes on a
 * node for its renderers, its hit index, its accessible tree and its reuse machinery. vega's own are the channels of its JSON
 * schema and the fields its scenegraph and view read besides: `href`, `fontVariant`, `image` (the image mark's bitmap, which a
 * spec may give), `noBound` (a group item left out of its bounds), and a guide group item's `offset`, `position`, `translate`,
 * `padding` (vega-view-transforms' layout) and `format`, `formatType` (the captions); those stay channels.
 *
 * The conformance test `engine-slots-vs-vega.test.ts` derives both lists from their sources -- the type declarations, vega's
 * builds, and every name the engine's source mentions, tried as a channel against every renderer -- and fails on a name that
 * changes any output and is neither vega's nor refused here.
 */

/**
 * The fields of the engine's scene nodes that are its own (types.ts, and the two flags written beside them): never a channel.
 * vega's item fields (see the module comment) are not in it, nor the names starting with `_`, which {@link isEngineSlot}
 * refuses by their prefix.
 */
export const ENGINE_ITEM_SLOTS: ReadonlySet<string> = new Set([
  // SceneItem
  'mark', 'datum',
  // SceneGroup
  'marktype', 'name', 'role', 'items', 'hasLinks', 'markClip', 'markClipPathD', 'unbounded', 'clipPathD', 'parts', 'partMeta', 'unmeasuredFrom',
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
