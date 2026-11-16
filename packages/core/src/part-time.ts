/**
 * The engine's time family, put in its slot (see engine-parts.ts): the calendar (time.ts), the time formats (time-format.ts, through
 * locale-time.ts), the calendar scales (scale-calendar.ts) and the `timeunit` transform.
 */
import { installPart, type EngineParts } from './engine-parts.js'
import { timeunitRows } from './transform-timeunit.js'
import { time, utcTime } from './scale-calendar.js'
import {
  dayofyear, timeIntervalFor, timeOffset, timeSequence, timeUnitSpecifier, utcdayofyear, utcIntervalFor, utcOffset, utcSequence, utcweek, week,
} from './time.js'
import { defaultTimeLocale, timeFormatLocale } from './locale-time.js'

export const part: EngineParts['time'] = {
  timeunitRows, time, utcTime, timeIntervalFor, utcIntervalFor, timeOffset, utcOffset, timeSequence, utcSequence,
  dayofyear, utcdayofyear, week, utcweek, timeUnitSpecifier, defaultTimeLocale, timeFormatLocale,
}
installPart('time', part)
