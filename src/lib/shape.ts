import type { Shape, ShapesFile } from '../contracts/types.ts';

export function computeShape(occasion: string | null, s: ShapesFile): Shape {
  if (occasion === null) return s.default;
  return s.shapes.find((x) => new RegExp(x.re, x.flags).test(occasion))?.id ?? s.default;
}
