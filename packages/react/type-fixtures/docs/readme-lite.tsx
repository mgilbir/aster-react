import { SvgChart } from '@aster-charts/react/lite'
import { interaction } from '@aster-charts/react/interaction'

declare const spec: Record<string, unknown> // a Vega spec

export const Small = () => <SvgChart spec={spec as never} interaction={interaction} tooltip />
