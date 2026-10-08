// Color pipeline: all per-pixel color settings (temperature, tint, brightness, contrast,
// saturation, built-in looks and imported .cube LUTs) are baked into ONE 3D LUT per clip.
// The preview uploads it as a WebGL 3D texture, the export feeds the same data to FFmpeg's lut3d,
// so both look identical.
import type { ColorSettings, LookId } from './types';
import { clamp } from './time';

export const LUT_SIZE = 33;

export interface CubeLut {
  size: number;
  /** r-fastest RGB triples, length size^3*3, values 0..1 */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

export function parseCube(text: string): CubeLut {
  let size = 0;
  const dmin: [number, number, number] = [0, 0, 0];
  const dmax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) continue;
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported, please use a 3D .cube LUT');
    if (up.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (up.startsWith('DOMAIN_MIN')) {
      const p = line.split(/\s+/).slice(1).map(Number);
      dmin[0] = p[0];
      dmin[1] = p[1];
      dmin[2] = p[2];
      continue;
    }
    if (up.startsWith('DOMAIN_MAX')) {
      const p = line.split(/\s+/).slice(1).map(Number);
      dmax[0] = p[0];
      dmax[1] = p[1];
      dmax[2] = p[2];
      continue;
    }
    if (/^[A-Z_]/.test(up)) continue; // unknown keyword
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => isFinite(n))) values.push(parts[0], parts[1], parts[2]);
  }
  if (!size || size < 2 || size > 128) throw new Error('Not a valid .cube file (missing LUT_3D_SIZE)');
  if (values.length !== size * size * size * 3) throw new Error(`.cube file has ${values.length / 3} entries, expected ${size ** 3}`);
  return { size, data: Float32Array.from(values), domainMin: dmin, domainMax: dmax };
}

export function sampleCube(l: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const n = l.size - 1;
  const fr = clamp((r - l.domainMin[0]) / (l.domainMax[0] - l.domainMin[0]), 0, 1) * n;
  const fg = clamp((g - l.domainMin[1]) / (l.domainMax[1] - l.domainMin[1]), 0, 1) * n;
  const fb = clamp((b - l.domainMin[2]) / (l.domainMax[2] - l.domainMin[2]), 0, 1) * n;
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(n, r0 + 1), g1 = Math.min(n, g0 + 1), b1 = Math.min(n, b0 + 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const S = l.size;
  const idx = (ri: number, gi: number, bi: number) => (ri + gi * S + bi * S * S) * 3;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c000 = l.data[idx(r0, g0, b0) + c], c100 = l.data[idx(r1, g0, b0) + c];
    const c010 = l.data[idx(r0, g1, b0) + c], c110 = l.data[idx(r1, g1, b0) + c];
    const c001 = l.data[idx(r0, g0, b1) + c], c101 = l.data[idx(r1, g0, b1) + c];
    const c011 = l.data[idx(r0, g1, b1) + c], c111 = l.data[idx(r1, g1, b1) + c];
    const c00 = c000 + (c100 - c000) * dr, c10 = c010 + (c110 - c010) * dr;
    const c01 = c001 + (c101 - c001) * dr, c11 = c011 + (c111 - c011) * dr;
    const c0 = c00 + (c10 - c00) * dg, c1 = c01 + (c11 - c01) * dg;
    out[c] = c0 + (c1 - c0) * db;
  }
  return out;
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function sCurve(v: number, amount: number): number {
  // smooth contrast curve around 0.5
  const s = v * v * (3 - 2 * v);
  return v + (s - v) * amount;
}

function applyLook(look: LookId, r: number, g: number, b: number): [number, number, number] {
  switch (look) {
    case 'cinematic': {
      // teal shadows, warm highlights, gentle S-curve, slightly lifted blacks, a touch desaturated
      const L = luma(r, g, b);
      const sh = clamp(1 - L * 1.6, 0, 1);
      const hi = clamp((L - 0.45) * 1.8, 0, 1);
      r += -0.045 * sh + 0.06 * hi;
      g += 0.012 * sh + 0.02 * hi;
      b += 0.05 * sh - 0.05 * hi;
      const L2 = luma(r, g, b);
      r = L2 + (r - L2) * 0.88;
      g = L2 + (g - L2) * 0.88;
      b = L2 + (b - L2) * 0.88;
      r = sCurve(clamp(r, 0, 1), 0.35) * 0.96 + 0.025;
      g = sCurve(clamp(g, 0, 1), 0.35) * 0.96 + 0.025;
      b = sCurve(clamp(b, 0, 1), 0.35) * 0.96 + 0.03;
      return [r, g, b];
    }
    case 'horror': {
      // heavy desaturation, green/teal shadows, crushed darks, cold highlights
      const L = luma(r, g, b);
      r = L + (r - L) * 0.4;
      g = L + (g - L) * 0.4;
      b = L + (b - L) * 0.4;
      const sh = clamp(1 - L * 1.8, 0, 1);
      r += -0.05 * sh;
      g += 0.035 * sh;
      b += 0.02 * sh;
      const hi = clamp((L - 0.6) * 2, 0, 1);
      r -= 0.02 * hi;
      b += 0.03 * hi;
      const crush = (v: number) => clamp((v - 0.04) / 0.96, 0, 1);
      r = sCurve(crush(r), 0.5) * 0.92;
      g = sCurve(crush(g), 0.5) * 0.94;
      b = sCurve(crush(b), 0.5) * 0.93;
      return [r, g, b];
    }
    case 'vibrant': {
      // punchy Fortnite colors: strong saturation + vibrance, bright mids, slight warmth
      const L = luma(r, g, b);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx - mn;
      const k = 1.35 + 0.35 * (1 - sat); // vibrance: boost low-saturation colors more
      r = L + (r - L) * k;
      g = L + (g - L) * k;
      b = L + (b - L) * k;
      const gamma = (v: number) => Math.pow(clamp(v, 0, 1), 0.9);
      r = sCurve(gamma(r * 1.02), 0.25);
      g = sCurve(gamma(g), 0.25);
      b = sCurve(gamma(b * 0.98), 0.25);
      return [r, g, b];
    }
    default:
      return [r, g, b];
  }
}

export function isNeutralColor(c: ColorSettings): boolean {
  return (
    Math.abs(c.brightness) < 1e-4 &&
    Math.abs(c.contrast) < 1e-4 &&
    Math.abs(c.saturation) < 1e-4 &&
    Math.abs(c.temperature) < 1e-4 &&
    Math.abs(c.tint) < 1e-4 &&
    (c.look === 'none' || c.lookIntensity <= 1e-4) &&
    (!c.lutPath || c.lutIntensity <= 1e-4)
  );
}

/** Map one color through the clip's color settings. */
export function gradePixel(c: ColorSettings, userLut: CubeLut | null, r: number, g: number, b: number): [number, number, number] {
  // white balance
  const T = c.temperature;
  const Ti = c.tint;
  r *= 1 + 0.14 * T + 0.04 * Ti;
  g *= 1 + 0.02 * T - 0.08 * Ti;
  b *= 1 - 0.16 * T + 0.04 * Ti;
  // brightness (lift + gain)
  const B = c.brightness;
  r = r * (1 + 0.35 * B) + 0.08 * B;
  g = g * (1 + 0.35 * B) + 0.08 * B;
  b = b * (1 + 0.35 * B) + 0.08 * B;
  // contrast around mid grey
  const C = 1 + c.contrast * (c.contrast > 0 ? 0.9 : 0.7);
  r = (r - 0.5) * C + 0.5;
  g = (g - 0.5) * C + 0.5;
  b = (b - 0.5) * C + 0.5;
  // saturation
  const S = 1 + c.saturation;
  const L = luma(r, g, b);
  r = L + (r - L) * S;
  g = L + (g - L) * S;
  b = L + (b - L) * S;
  r = clamp(r, 0, 1);
  g = clamp(g, 0, 1);
  b = clamp(b, 0, 1);
  // look
  if (c.look !== 'none' && c.lookIntensity > 0) {
    const [lr, lg, lb] = applyLook(c.look, r, g, b);
    const k = c.lookIntensity;
    r = r + (clamp(lr, 0, 1) - r) * k;
    g = g + (clamp(lg, 0, 1) - g) * k;
    b = b + (clamp(lb, 0, 1) - b) * k;
  }
  // imported LUT
  if (userLut && c.lutIntensity > 0) {
    const [ur, ug, ub] = sampleCube(userLut, r, g, b);
    const k = c.lutIntensity;
    r = r + (ur - r) * k;
    g = g + (ug - g) * k;
    b = b + (ub - b) * k;
  }
  return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
}

/** Build the combined LUT (r-fastest) for a clip's color settings. */
export function buildClipLut(c: ColorSettings, userLut: CubeLut | null, size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size * size * size * 3);
  const n = size - 1;
  let i = 0;
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = gradePixel(c, userLut, ri / n, gi / n, bi / n);
        out[i++] = r;
        out[i++] = g;
        out[i++] = b;
      }
  return out;
}

export function lutToCubeText(data: Float32Array, size = LUT_SIZE, title = 'islandcut'): string {
  const lines: string[] = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** FFmpeg vignette angle for a 0..1 slider (shader uses the same formula: cos(angle*d/dmax)^4). */
export function vignetteAngle(v: number): number {
  return clamp(v, 0, 1) * 1.15;
}

/** Signature for caching LUTs. */
export function colorSig(c: ColorSettings): string {
  return [c.brightness, c.contrast, c.saturation, c.temperature, c.tint, c.look, c.lookIntensity, c.lutPath ?? '', c.lutIntensity]
    .map((x) => (typeof x === 'number' ? x.toFixed(4) : x))
    .join('|');
}
