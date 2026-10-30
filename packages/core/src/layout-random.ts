/**
 * The generator the force simulation and the circle packer draw their randomness from: a fixed-seed linear congruential
 * stream, so a layout is the same on every run. The constants and the draw order are part of the observable result (a
 * jiggled node, a shuffled enclosing-circle search): a packer or a simulation consumes it in a fixed sequence.
 */
export function layoutRandom(): () => number {
  let state = 1
  return () => (state = (1664525 * state + 1013904223) % 4294967296) / 4294967296
}
