/** The parts of a date, from the year down: the single time units, and the parts a DateTime names. */
export const CALENDAR_PARTS = ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'date', 'hours', 'minutes', 'seconds', 'milliseconds'] as const

export type CalendarPart = (typeof CALENDAR_PARTS)[number]
