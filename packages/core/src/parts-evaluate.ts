/**
 * Every part of the engine an evaluation can need besides the pulse path (see engine-parts.ts): what the entries that compile and
 * evaluate a spec carry, so that their synchronous functions work for every spec, with nothing to load first.
 */
import './part-legend.js'
import './part-layout.js'
import './part-selections.js'
import './part-regex.js'
import './part-svgpath.js'
