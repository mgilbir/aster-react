/**
 * Pin the engine's `Array.prototype.sort` for the in-process oracle.
 *
 * Vega sorts with the native sort and, for a comparator that is not a strict weak order (a domain mixing
 * strings and numbers, `NaN`), its result is whatever comparison sequence the engine makes. V8 15.x (Node 27) has
 * Maglev inline `Array.prototype.sort` at a hot call site with a different comparison order from the builtin, so
 * the same Vega call site returns another order once it has been compiled. The differentials run real Vega next to
 * Aster for thousands of cases; without the pin the oracle itself changes under them part way through a file.
 *
 * Aster does not rely on this pin: `sortData` (packages/core/src/util.ts) keeps its own call sites on the builtin,
 * and packages/conformance/src/sort-engine.test.ts turns the engine's inlining back ON to prove it.
 *
 * The flag only exists on V8 versions that have the reducer; vitest.config.mjs probes for it once and passes the
 * answer in ASTER_V8_SORT_FLAG ('' on engines that need no pin).
 */
import v8 from 'node:v8'

const flag = process.env.ASTER_V8_SORT_FLAG
if (flag) v8.setFlagsFromString(flag)
