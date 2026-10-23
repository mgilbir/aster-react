import * as React from 'react'
import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'
import type { VgSpec } from '@aster/core'

declare const spec: VgSpec

export const ok = <SvgChart spec={spec} interaction={interaction} tooltip />
// @ts-expect-error `tooltip` needs the interaction capability: pass interaction={interaction}
export const missing = <SvgChart spec={spec} tooltip />
