/**
 * The identity transform for untransformed TopoJSON topologies — part of the
 * topojson-client port (`./topojson.ts`).
 */

type Point = [number, number, ...number[]]

/** An absolute-coordinate pass-through that extends degenerate points. */
export default function (x: number[]): Point {
  return x as unknown as Point
}
