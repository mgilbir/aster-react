/**
 * The zones the time-zone matrix (`pnpm test:tz`) runs under, in one place: the matrix runs them, and the unit test that holds
 * what real vega draws in each (packages/core/src/calendar.tz.test.ts) is checked to cover exactly these.
 */

/** Three zones with different offsets: one with DST, one half-hour offset without, one ahead of UTC whose daylight saving is half an hour. */
export const ZONES = ['America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe']
