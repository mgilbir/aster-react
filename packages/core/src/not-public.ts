/**
 * The declaration a consumer's TypeScript finds for `@aster-charts/core/internal*`: none. Those entries are plumbing for the sibling
 * packages and this repo's tests, not public API (no semver, no declarations): this module declares nothing, so a consumer that
 * imports a name from one of them gets "has no exported member" at compile time. (This repo's own tsconfig names the
 * `aster-internal` condition, which finds the real declarations.)
 */
export {}
