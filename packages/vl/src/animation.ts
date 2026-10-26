/**
 * Vega-Lite 6 animation: the `time` channel and the timer selection that drives it.
 *
 * vega-lite 6.4.3 compiles an animation from three pieces, all ported here (compile/selection/point.ts
 * `animationSignals` and `topLevelSignals`, compile/selection/assemble.ts `assembleUnitSelectionData`,
 * compile/scale/range.ts for the TIME channel, compile/unit.ts `correctDataNames`):
 *
 *  - a `point` selection param whose `on` is a timer: `{"name": "anim", "select": {"type": "point", "on": "timer",
 *    "fields": ["year"]}}` (or `"encodings": ["time"]`). It compiles to a store dataset (`anim_store`) and a chain
 *    of signals: a clock that a `timer` event stream advances while `is_playing`, the `time` scale's value at that
 *    clock (`invert('time', clock)`), and a tuple of it that `modify("anim_store", tuple, true)` writes to the store;
 *  - a `filter: {param: "anim"}` transform: the selection's predicate (`!length(data(store)) || vlSelectionTest(...)`),
 *    which vega-lite moves out of the main dataset into `<main>_curr`, the dataset the marks read, so scales keep
 *    the whole data's domains while only the current frame is drawn;
 *  - the `time` encoding channel: a band scale (`range: {step: 1000 / config.scale.framesPerSecond}`) over the
 *    field, no axis, no legend. (Its `animationDuration` is unused by vega-lite 6.4.3, a linear time scale being
 *    unimplemented upstream.)
 *
 * What vega-lite 6.4.3 does NOT do is validate: a `time` channel without the timer selection and its filter compiles
 * to marks that read a dataset it never defines. Those specs are refused here, with the reason.
 *
 * The first frame (before the first tick) is all of the data: the store is empty, so the predicate lets every row
 * through; the clock then starts and the tuples arrive.
 */
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** vega-lite's THROTTLE: the timer stream runs at 60 frames per second. */
const THROTTLE = (1 / 60) * 1000

/** Is this a `select` whose `on` is a timer: `"timer"`, `"timer{<ms>}"` or `{"type": "timer"}` (vega-lite `isTimerSelection`)? */
export function isTimerSelect(select: unknown): boolean {
  if (!isObj(select) || select.type !== 'point') return false
  const on = select.on
  if (typeof on === 'string') return /^\s*timer\s*(\{\s*\d+(\.\d+)?\s*\})?\s*$/.test(on)
  if (isObj(on)) return on.type === 'timer'
  return false
}

/** A timer selection param, checked: throws a VLCompileError naming what is not supported. */
export function validateTimerSelection(param: Obj, at: string, fail: (path: string, msg: string) => never): void {
  const select = param.select as Obj
  for (const k of Object.keys(select)) {
    if (!['type', 'on', 'fields', 'encodings'].includes(k)) fail(`${at}.select.${k}`, 'a timer selection takes only `type`, `on` and one of `fields` / `encodings` (the animation options vega-lite 6.4.3 has are these)')
  }
  if (isObj(select.on)) {
    for (const k of Object.keys(select.on)) if (k !== 'type' && k !== 'throttle') fail(`${at}.select.on.${k}`, 'a timer event stream is {"type": "timer"} (vega-lite replaces its throttle with its own 60 fps clock)')
  }
  const hasFields = select.fields !== undefined
  const hasEnc = select.encodings !== undefined
  if (hasFields === hasEnc) {
    fail(`${at}.select`, 'a timer selection needs exactly one of `fields` or `encodings` (without either, vega-lite 6.4.3 selects by row id and emits marks that read a dataset it never defines)')
  }
  if (hasFields) {
    const f = select.fields
    if (!Array.isArray(f) || f.length === 0 || !f.every((x) => typeof x === 'string' && x !== '')) fail(`${at}.select.fields`, 'must be a non-empty array of field names')
  } else {
    const e = select.encodings
    if (!Array.isArray(e) || e.length !== 1 || e[0] !== 'time') fail(`${at}.select.encodings`, 'a timer selection can project the `time` encoding only: ["time"]')
  }
  if (param.value !== undefined) fail(`${at}.value`, 'an initial value does not apply to a timer selection')
  if (param.bind !== undefined) fail(`${at}.bind`, 'a bound timer selection is not supported')
}

/**
 * point.ts `topLevelSignals`: the clock of a timer selection. It advances by the time between ticks (`now() - last_tick_at`)
 * while `is_playing` and wraps at the end of the `time` scale's range.
 */
export function animationTopLevelSignals(signals: Obj[]): Obj[] {
  return signals.concat([
    {
      name: 'anim_clock',
      init: '0',
      on: [{
        events: { type: 'timer', throttle: THROTTLE },
        update: 'is_playing ? (anim_clock + (now() - last_tick_at) > max_range_extent ? 0 : anim_clock + (now() - last_tick_at)) : anim_clock',
      }],
    },
    { name: 'last_tick_at', init: 'now()', on: [{ events: [{ signal: 'anim_clock' }, { signal: 'is_playing' }], update: 'now()' }] },
    { name: 'is_playing', init: 'true' },
  ])
}

/** point.ts `animationSignals`: the clock eased, and the `time` scale's value at it. */
export function animationSignals(selectionName: string, scaleName: string): Obj[] {
  return [
    { name: 'eased_anim_clock', update: 'anim_clock' },
    { name: `${selectionName}_domain`, init: `domain('${scaleName}')` },
    { name: 'min_extent', init: `extent(${selectionName}_domain)[0]` },
    { name: 'max_range_extent', init: `extent(range('${scaleName}'))[1]` },
    { name: 'anim_value', update: `invert('${scaleName}', eased_anim_clock)` },
  ]
}

/** point.ts `signals` of a timer selection: the tuple of the frame the clock is at. */
export function animationTupleSignal(selectionName: string, unitName: string): Obj {
  const tuple = `${selectionName}_tuple`
  return {
    name: tuple,
    on: [{
      events: [{ signal: 'eased_anim_clock' }, { signal: 'anim_value' }],
      update: `{unit: ${unitName}, fields: ${tuple}_fields, values: [anim_value ? anim_value : min_extent]}`,
      force: true,
    }],
  }
}

/** The `time` scale's range: one step per frame (vega-lite scale/range.ts, TIME). */
export function timeScaleRange(framesPerSecond: unknown): Obj {
  const fps = typeof framesPerSecond === 'number' ? framesPerSecond : 2
  return { step: 1000 / fps }
}
