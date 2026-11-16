/** The aggregation engine (`aggregate`, `joinaggregate`, `pivot`, a facet's groups, a domain sorted by an aggregate), put in its slot (see engine-parts.ts). */
import { installPart, type EngineParts } from './engine-parts.js'
import { aggregateGroups, aggregateRows, joinAggregateRows, pivotRows } from './transform-agg.js'

export const part: EngineParts['aggregate'] = { aggregateRows, aggregateGroups, joinAggregateRows, pivotRows }
installPart('aggregate', part)
