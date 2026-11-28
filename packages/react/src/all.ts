/**
 * `@aster-charts/react/all` — load the whole engine up front.
 *
 * In a browser build (the `browser` export condition) the shells load the parts of the engine that most charts never run on demand:
 * a chart whose spec needs one (a legend, a time scale, a colour ramp, an aggregate, a curve...) suspends once, the first time
 * any chart on the page needs it, while that part is fetched. Importing this module (for its side effect) puts every part in place
 * before the first render, so no chart ever suspends for one; the price is the bytes of every part, whether or not the app's
 * charts use them (the `Chart + all` row of the bundle budget).
 *
 *   import '@aster-charts/react/all'
 *   import { Chart } from '@aster-charts/react'
 *
 * Outside a browser build (a server render, a test runner) every part is already there and this import changes nothing. The opt-in
 * add-ons (`@aster-charts/core/geo`, `/transforms`, `/load`) are not parts: an app that wants no wait for those imports them too.
 * To load some families ahead of time without bundling them up front, see `preloadParts`.
 */
import '@aster-charts/core/internal/all'
