// Must NOT compile, exactly at the lines marked `@error`: <SvgChart> without `interaction` rejects every prop that
// needs hit testing or the event loop, and the canvas renderer. A line carrying `@error` on the line above it
// must produce a diagnostic, and no other line may.
import * as React from 'react'
import { SvgChart } from '../src/SvgChart.js'
import { interaction } from '../src/interaction-capability.js'
import type { InteractionCapability } from '../src/capabilities.js'
import { spec } from './shared.js'

// @error
export const a = <SvgChart spec={spec} tooltip />
// @error
export const b = <SvgChart spec={spec} renderTooltip={() => null} />
// @error
export const c = <SvgChart spec={spec} onPointSelect={() => {}} />
// @error
export const d = <SvgChart spec={spec} selection={null} />
// @error
export const e = <SvgChart spec={spec} select={null} />
// @error
export const f = <SvgChart spec={spec} onSelectionChange={() => {}} />
// @error
export const g = <SvgChart spec={spec} preventDefault />
// @error
export const h = <SvgChart spec={spec} renderer="canvas" />
// @error
export const i = <SvgChart spec={spec} interaction={undefined} tooltip />
// @error
export const j = <SvgChart spec={spec} interaction={{} as Pick<InteractionCapability, 'buildHitIndex'>} />
// @error
export const k = <SvgChart interaction={interaction} />
// @error
export const l = <SvgChart spec={spec} tooltip="yes" interaction={interaction} />
