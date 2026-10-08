// Logo Maker rendering: text logos (gradient fill, double outline, 3D extrude, glow) and
// background removal for image logos. Everything renders to a transparent canvas.

export interface TextLogoStyle {
  line1: string;
  line2: string;
  font: string;
  weight: number;
  size: number; // px of line 1 at full resolution
  line2Scale: number; // line 2 size relative to line 1
  letterSpacing: number; // em fraction
  fill1: string;
  fill2: string;
  gradient: boolean;
  outline: string;
  outlineWidth: number; // px
  outer: string;
  outerWidth: number; // px, drawn behind the outline (thick "sticker" border)
  depth: number; // 3D extrude in px
  depthColor: string;
  glow: string;
  glowSize: number;
  tilt: number; // degrees
  uppercase: boolean;
}

export const LOGO_PRESETS: { id: string; label: string; style: Partial<TextLogoStyle> }[] = [
  { id: 'battle', label: 'Battle Royale', style: { font: 'Luckiest Guy', weight: 400, fill1: '#fff35c', fill2: '#ff9d00', gradient: true, outline: '#1b1464', outlineWidth: 10, outer: '#ffffff', outerWidth: 0, depth: 14, depthColor: '#0e0a3a', glow: '#000000', glowSize: 18, tilt: -4, letterSpacing: 0.02, uppercase: true } },
  { id: 'sticker', label: 'Sticker', style: { font: 'Lilita One', weight: 400, fill1: '#4fd1ff', fill2: '#2b6bff', gradient: true, outline: '#0b1d4d', outlineWidth: 8, outer: '#ffffff', outerWidth: 16, depth: 8, depthColor: '#0b1d4d', glow: '#000000', glowSize: 10, tilt: -3, letterSpacing: 0.02, uppercase: true } },
  { id: 'horror', label: 'Horror', style: { font: 'Creepster', weight: 400, fill1: '#ff2a2a', fill2: '#6b0000', gradient: true, outline: '#000000', outlineWidth: 6, outer: '#000000', outerWidth: 0, depth: 0, depthColor: '#000000', glow: '#ff0000', glowSize: 30, tilt: 0, letterSpacing: 0.04, uppercase: true } },
  { id: 'scifi', label: 'Sci-fi', style: { font: 'Orbitron', weight: 900, fill1: '#e9fbff', fill2: '#5ee7ff', gradient: true, outline: '#0b2b3a', outlineWidth: 4, outer: '#000000', outerWidth: 0, depth: 0, depthColor: '#000000', glow: '#00d0ff', glowSize: 36, tilt: 0, letterSpacing: 0.12, uppercase: true } },
  { id: 'cinematic', label: 'Cinematic', style: { font: 'Cinzel', weight: 700, fill1: '#fff1c4', fill2: '#c99a3b', gradient: true, outline: '#2a1a00', outlineWidth: 2, outer: '#000000', outerWidth: 0, depth: 0, depthColor: '#000000', glow: '#000000', glowSize: 24, tilt: 0, letterSpacing: 0.16, uppercase: true } },
  { id: 'arcade', label: 'Arcade', style: { font: 'Press Start 2P', weight: 400, fill1: '#ffffff', fill2: '#ff4fd8', gradient: true, outline: '#2a0033', outlineWidth: 6, outer: '#00f0ff', outerWidth: 12, depth: 10, depthColor: '#2a0033', glow: '#000000', glowSize: 0, tilt: 0, letterSpacing: 0.02, uppercase: true } },
  { id: 'clean', label: 'Clean', style: { font: 'Montserrat', weight: 800, fill1: '#ffffff', fill2: '#ffffff', gradient: false, outline: '#000000', outlineWidth: 0, outer: '#000000', outerWidth: 0, depth: 0, depthColor: '#000000', glow: '#000000', glowSize: 22, tilt: 0, letterSpacing: 0.06, uppercase: true } },
  { id: 'graffiti', label: 'Graffiti', style: { font: 'Permanent Marker', weight: 400, fill1: '#b6ff3b', fill2: '#18c964', gradient: true, outline: '#101010', outlineWidth: 8, outer: '#ffffff', outerWidth: 6, depth: 10, depthColor: '#101010', glow: '#000000', glowSize: 12, tilt: -6, letterSpacing: 0.0, uppercase: false } },
];

export const DEFAULT_LOGO: TextLogoStyle = {
  line1: 'MY ISLAND',
  line2: '',
  size: 220,
  line2Scale: 0.36,
  ...(LOGO_PRESETS[0].style as Omit<TextLogoStyle, 'line1' | 'line2' | 'size' | 'line2Scale'>),
};

/** Render a text logo. Returns a canvas trimmed to the logo with a small margin. */
export function renderTextLogo(st: TextLogoStyle): HTMLCanvasElement {
  const l1 = st.uppercase ? st.line1.toUpperCase() : st.line1;
  const l2 = st.uppercase ? st.line2.toUpperCase() : st.line2;
  const size2 = Math.round(st.size * st.line2Scale);
  const meas = document.createElement('canvas').getContext('2d')!;
  const font = (px: number) => `${st.weight} ${px}px "${st.font}", "Arial Black", Arial, sans-serif`;
  const width = (text: string, px: number) => {
    meas.font = font(px);
    (meas as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${st.letterSpacing * px}px`;
    return meas.measureText(text).width;
  };
  const w1 = l1 ? width(l1, st.size) : 0;
  const w2 = l2 ? width(l2, size2) : 0;
  const pad = st.outerWidth + st.outlineWidth + st.depth + st.glowSize * 2 + 40;
  const lineGap = st.size * 0.08;
  const h1 = l1 ? st.size * 1.15 : 0;
  const h2 = l2 ? size2 * 1.25 : 0;
  const bw = Math.ceil(Math.max(w1, w2) + pad * 2);
  const bh = Math.ceil(h1 + h2 + (l1 && l2 ? lineGap : 0) + pad * 2);
  // room for the tilt
  const diag = Math.ceil(Math.hypot(bw, bh));
  const cv = document.createElement('canvas');
  cv.width = Math.max(4, diag);
  cv.height = Math.max(4, diag);
  const ctx = cv.getContext('2d')!;
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate((st.tilt * Math.PI) / 180);
  ctx.translate(-bw / 2, -bh / 2);
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines: { text: string; px: number; y: number }[] = [];
  if (l1) lines.push({ text: l1, px: st.size, y: pad + h1 / 2 });
  if (l2) lines.push({ text: l2, px: size2, y: pad + h1 + (l1 ? lineGap : 0) + h2 / 2 });
  const cx = bw / 2;
  const setFont = (px: number) => {
    ctx.font = font(px);
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${st.letterSpacing * px}px`;
  };
  const k = (px: number) => px / st.size; // scale strokes for the smaller line

  // 1) glow / shadow behind everything (drawn with the outer silhouette)
  if (st.glowSize > 0) {
    ctx.save();
    ctx.shadowColor = st.glow;
    ctx.shadowBlur = st.glowSize;
    for (const L of lines) {
      setFont(L.px);
      ctx.fillStyle = st.glow;
      ctx.strokeStyle = st.glow;
      ctx.lineWidth = (st.outerWidth + st.outlineWidth) * 2 * k(L.px) + 1;
      const dd = st.depth * k(L.px);
      ctx.strokeText(L.text, cx + dd, L.y + dd);
      ctx.fillText(L.text, cx + dd, L.y + dd);
    }
    ctx.restore();
  }
  // 2) 3D extrude: stacked copies down-right
  for (const L of lines) {
    setFont(L.px);
    const d = Math.round(st.depth * k(L.px));
    for (let i = d; i >= 1; i--) {
      ctx.fillStyle = st.depthColor;
      ctx.strokeStyle = st.depthColor;
      ctx.lineWidth = (st.outerWidth + st.outlineWidth) * 2 * k(L.px);
      if (ctx.lineWidth > 0) ctx.strokeText(L.text, cx + i, L.y + i);
      ctx.fillText(L.text, cx + i, L.y + i);
    }
  }
  // 3) thick outer border, 4) outline, 5) gradient fill + subtle top highlight
  for (const L of lines) {
    setFont(L.px);
    if (st.outerWidth > 0) {
      ctx.strokeStyle = st.outer;
      ctx.lineWidth = (st.outerWidth + st.outlineWidth) * 2 * k(L.px);
      ctx.strokeText(L.text, cx, L.y);
    }
    if (st.outlineWidth > 0) {
      ctx.strokeStyle = st.outline;
      ctx.lineWidth = st.outlineWidth * 2 * k(L.px);
      ctx.strokeText(L.text, cx, L.y);
    }
    if (st.gradient) {
      const g = ctx.createLinearGradient(0, L.y - L.px * 0.45, 0, L.y + L.px * 0.45);
      g.addColorStop(0, st.fill1);
      g.addColorStop(1, st.fill2);
      ctx.fillStyle = g;
    } else ctx.fillStyle = st.fill1;
    ctx.fillText(L.text, cx, L.y);
  }
  return trimCanvas(cv, 12);
}

/** Crop away fully transparent borders, keeping `margin` px. */
export function trimCanvas(cv: HTMLCanvasElement, margin = 8): HTMLCanvasElement {
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const { width: w, height: h } = cv;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > 6) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return cv;
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin);
  y1 = Math.min(h - 1, y1 + margin);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export interface BgRemoveOptions {
  /** colour to remove; null = detect from the image border */
  color: [number, number, number] | null;
  tolerance: number; // 0..100
  feather: number; // 0..100
  /** only remove background connected to the border (keeps same-coloured areas inside the logo) */
  connected: boolean;
}

/** Most common border colour (quantized), used as the background guess. */
export function borderColor(img: ImageData): [number, number, number] {
  const { width: w, height: h, data } = img;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 128) return;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += data[i];
    c.g += data[i + 1];
    c.b += data[i + 2];
    counts.set(key, c);
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    add(0, y);
    add(w - 1, y);
  }
  let best = { n: 0, r: 255, g: 255, b: 255 };
  for (const c of counts.values()) if (c.n > best.n) best = c;
  return best.n ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
}

/** True if the image already has real transparency. */
export function hasTransparency(img: ImageData): boolean {
  const d = img.data;
  let transparent = 0;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 200) transparent++;
  return transparent > d.length / 16 / 50; // > 2% of sampled pixels
}

/** Remove a flat background. Returns new ImageData with alpha, colour spill removed at the edges. */
export function removeBackground(img: ImageData, o: BgRemoveOptions): ImageData {
  const { width: w, height: h } = img;
  const src = img.data;
  const out = new ImageData(new Uint8ClampedArray(src), w, h);
  const d = out.data;
  const bg = o.color ?? borderColor(img);
  const tol = 4 + (o.tolerance / 100) * 160; // colour distance
  const soft = (o.feather / 100) * 60 + 1;
  const dist = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    dist[p] = Math.hypot(src[i] - bg[0], src[i + 1] - bg[1], src[i + 2] - bg[2]);
  }
  // which pixels may become transparent
  let region: Uint8Array;
  if (o.connected) {
    region = new Uint8Array(w * h);
    const stack: number[] = [];
    const push = (p: number) => {
      if (!region[p] && dist[p] < tol + soft) {
        region[p] = 1;
        stack.push(p);
      }
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    while (stack.length) {
      const p = stack.pop()!;
      if (dist[p] >= tol) continue; // soft edge pixels are included but don't spread
      const x = p % w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < w * (h - 1)) push(p + w);
    }
  } else region = new Uint8Array(w * h).fill(1);
  for (let p = 0; p < w * h; p++) {
    if (!region[p]) continue;
    const i = p * 4;
    const a = Math.min(1, Math.max(0, (dist[p] - tol) / soft));
    const alpha = a * (src[i + 3] / 255);
    d[i + 3] = Math.round(alpha * 255);
    if (alpha > 0.01 && alpha < 0.99) {
      // un-mix the background colour from semi-transparent edge pixels
      for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, (src[i + c] - (1 - alpha) * bg[c]) / alpha));
    }
  }
  return out;
}

export function canvasFromImageData(img: ImageData): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv;
}

export async function canvasToPng(cv: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not encode PNG');
  return new Uint8Array(await blob.arrayBuffer());
}
