// Helpers to turn sampled animation curves into compact FFmpeg expressions.

export interface Pt {
  t: number;
  v: number;
}

/** Ramer–Douglas–Peucker simplification of a 1D curve. */
export function simplify(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a];
    const pb = points[b];
    let maxD = -1;
    let idx = -1;
    const span = pb.t - pa.t;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const k = span > 0 ? (p.t - pa.t) / span : 0;
      const d = Math.abs(p.v - (pa.v + (pb.v - pa.v) * k));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function fmt(n: number, digits = 4): string {
  if (!isFinite(n)) return '0';
  const s = n.toFixed(digits);
  // trim trailing zeros
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
}

export function isConstant(points: Pt[], tolerance: number): boolean {
  if (points.length === 0) return true;
  const v0 = points[0].v;
  return points.every((p) => Math.abs(p.v - v0) <= tolerance);
}

/**
 * Piecewise-linear expression of `t` through the given points (flat sum of segments, no deep nesting).
 * Before the first point and after the last the curve is held constant.
 * Every boundary is formatted ONCE and reused on both sides, so adjacent segments meet exactly
 * (no frame can fall into a rounding gap and evaluate to 0).
 */
export function pwlExpr(points: Pt[], variable = 't'): string {
  if (points.length === 0) return '0';
  if (points.length === 1) return fmt(points[0].v);
  const B = points.map((p) => fmt(p.t, 6));
  const terms: string[] = [];
  terms.push(`lt(${variable},${B[0]})*${fmt(points[0].v)}`);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (B[i] === B[i + 1]) continue;
    const span = b.t - a.t;
    const k = span > 0 ? (b.v - a.v) / span : 0;
    const seg = Math.abs(k) < 1e-9 ? fmt(a.v) : `(${fmt(a.v)}+(${variable}-${B[i]})*${fmt(k, 6)})`;
    terms.push(`gte(${variable},${B[i]})*lt(${variable},${B[i + 1]})*${seg}`);
  }
  terms.push(`gte(${variable},${B[B.length - 1]})*${fmt(points[points.length - 1].v)}`);
  return terms.join('+');
}

/** Escape a value for use inside single quotes in an FFmpeg filtergraph. */
export function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
}
