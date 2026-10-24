import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'

declare const spec: Record<string, unknown> // a Vega spec

export const Small = () => <SvgChart spec={spec as never} interaction={interaction} tooltip />
