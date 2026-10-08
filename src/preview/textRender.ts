// Text/title renderer (Canvas 2D). Used for BOTH the live preview and the export
// (exported titles are rendered to PNG frames with this same code), so they match exactly.
import type { TextAnimation, TextProps } from '../../shared/types';
import { clamp } from '../../shared/time';
import { hash01 } from '../../shared/evaluate';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const easeOutCubic = (k: number) => 1 - Math.pow(1 - clamp(k, 0, 1), 3);
const easeInCubic = (k: number) => Math.pow(clamp(k, 0, 1), 3);
const easeOutBack = (k: number) => {
  k = clamp(k, 0, 1);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
};

export function textIsAnimated(t: TextProps): boolean {
  return t.animIn !== 'none' || t.animOut !== 'none';
}

interface AnimState {
  alpha: number;
  dy: number;
  dx: number;
  scale: number;
  chars: number; // fraction of characters visible (typewriter)
  glitch: number; // 0..1
  ghost: number; // slam motion-blur ghosts 0..1
  cursor: boolean;
}

function animState(t: TextProps, local: number, dur: number, frame: number, H: number): AnimState {
  const s: AnimState = { alpha: 1, dy: 0, dx: 0, scale: 1, chars: 1, glitch: 0, ghost: 0, cursor: false };
  const apply = (a: TextAnimation, p: number, out: boolean) => {
    // p: 0 -> start of animation, 1 -> fully settled (for out-animations we pass the reversed progress)
    switch (a) {
      case 'fadeUp': {
        const k = easeOutCubic(p);
        s.alpha *= k;
        s.dy += (out ? -1 : 1) * (1 - k) * H * 0.04;
        break;
      }
      case 'scalePunch': {
        const k = out ? easeOutCubic(p) : easeOutBack(p);
        s.scale *= out ? 0.6 + 0.4 * k : 1.5 - 0.5 * k;
        s.alpha *= clamp(p * 3, 0, 1);
        break;
      }
      case 'typewriter': {
        s.chars = Math.min(s.chars, p);
        s.cursor = p < 1 || Math.floor(frame / 15) % 2 === 0;
        break;
      }
      case 'glitchIn': {
        s.glitch = Math.max(s.glitch, 1 - p);
        s.alpha *= p < 0.6 ? (hash01(frame, 21) < 0.35 + p ? 1 : 0.15) : 1;
        break;
      }
      case 'slam': {
        if (!out) {
          const hit = 0.45; // fraction of the animation when the text lands
          if (p < hit) {
            const k = easeInCubic(p / hit);
            s.scale *= 3.2 - 2.2 * k;
            s.alpha *= clamp(p / hit * 2.5, 0, 1);
            s.ghost = 1 - k;
          } else {
            const q = (p - hit) / (1 - hit);
            const amp = (1 - q) * (1 - q) * H * 0.018;
            s.dx += Math.sin(frame * 2.7) * amp;
            s.dy += Math.cos(frame * 3.3) * amp;
            s.scale *= 1 + 0.06 * (1 - easeOutCubic(q));
          }
        } else {
          s.alpha *= p;
          s.scale *= 1 + 0.2 * (1 - p);
        }
        break;
      }
      default:
        break;
    }
  };
  if (t.animIn !== 'none' && t.animInDuration > 0 && local < t.animInDuration) apply(t.animIn, local / t.animInDuration, false);
  const outStart = dur - t.animOutDuration;
  if (t.animOut !== 'none' && t.animOutDuration > 0 && local > outStart) apply(t.animOut, (dur - local) / t.animOutDuration, true);
  return s;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function font(t: TextProps, size: number): string {
  return `${t.italic ? 'italic ' : ''}${t.fontWeight} ${size}px "${t.fontFamily}", "Arial Black", Arial, sans-serif`;
}

/**
 * Draw a text clip onto a transparent canvas of the output size.
 * @param k scale factor output/project (font sizes are in project pixels at 1080p height)
 */
export function drawText(ctx: Ctx, W: number, H: number, t: TextProps, local: number, dur: number, fps: number, projectH: number): void {
  const k = H / 1080; // font sizes are authored for a 1080-tall frame
  void projectH;
  const frame = Math.round(local * fps);
  const st = animState(t, local, dur, frame, H);
  ctx.clearRect(0, 0, W, H);
  if (st.alpha <= 0.001) return;

  const raw = t.uppercase ? t.text.toUpperCase() : t.text;
  const totalChars = raw.length;
  const visibleChars = Math.floor(totalChars * clamp(st.chars, 0, 1) + 1e-6);
  const shown = raw.slice(0, visibleChars);
  const lines = shown.split('\n');
  const fullLines = raw.split('\n');
  const size = t.fontSize * k;
  const lh = size * t.lineHeight;
  ctx.save();
  ctx.font = font(t, size);
  (ctx as CanvasRenderingContext2D).letterSpacing = `${t.letterSpacing * k}px`;
  ctx.textBaseline = 'alphabetic';
  // Measure using the full text so typewriter reveal does not shift the layout
  const widths = fullLines.map((l) => ctx.measureText(l).width);
  const sub = t.subText ? (t.uppercase ? t.subText.toUpperCase() : t.subText) : '';
  const subSize = (t.subSize ?? t.fontSize * 0.4) * k;
  let subW = 0;
  if (sub) {
    ctx.font = font({ ...t, fontWeight: Math.min(800, t.fontWeight) }, subSize);
    subW = ctx.measureText(sub).width;
    ctx.font = font(t, size);
  }
  const blockW = Math.max(...widths, subW);
  const blockH = lh * fullLines.length + (sub ? subSize * 1.5 : 0);
  const ax = t.posX * W;
  const ay = t.posY * H;
  let left = t.align === 'center' ? ax - blockW / 2 : t.align === 'right' ? ax - blockW : ax;
  const top = ay - blockH / 2;

  ctx.translate(ax + st.dx, ay + st.dy);
  ctx.scale(st.scale, st.scale);
  ctx.translate(-ax, -ay);
  ctx.globalAlpha = st.alpha;

  // box / accent
  const pad = t.boxPadding * k;
  if (t.box) {
    ctx.fillStyle = t.boxColor;
    roundRect(ctx, left - pad - (t.accentBar ? 10 * k : 0), top - pad * 0.7, blockW + pad * 2 + (t.accentBar ? 10 * k : 0), blockH + pad * 1.4, t.boxRadius * k);
    ctx.fill();
  }
  if (t.accentBar) {
    ctx.fillStyle = t.accentColor;
    const barX = left - pad - (t.box ? 10 * k : 18 * k);
    ctx.fillRect(barX, top - pad * 0.5, 8 * k, blockH + pad);
    if (!t.box) left += 4 * k;
  }

  const drawLines = (offX: number, color: string | null, alphaMul: number, comp?: GlobalCompositeOperation) => {
    ctx.save();
    if (comp) ctx.globalCompositeOperation = comp;
    ctx.globalAlpha = st.alpha * alphaMul;
    lines.forEach((line, i) => {
      const w = widths[i] ?? 0;
      const x = (t.align === 'center' ? ax - w / 2 : t.align === 'right' ? ax - w : left) + offX;
      const y = top + lh * (i + 0.8);
      if (t.outlineWidth > 0 && color === null) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = t.outlineWidth * 2 * k;
        ctx.strokeStyle = t.outlineColor;
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = color ?? t.color;
      ctx.fillText(line, x, y);
    });
    ctx.restore();
  };

  // shadow pass
  if (t.shadowBlur > 0 || t.shadowOffset > 0) {
    ctx.save();
    ctx.shadowColor = t.shadowColor;
    ctx.shadowBlur = t.shadowBlur * k;
    ctx.shadowOffsetX = t.shadowOffset * k;
    ctx.shadowOffsetY = t.shadowOffset * k;
    drawLines(0, null, 1);
    ctx.restore();
  }
  // slam ghosts
  if (st.ghost > 0.01) {
    for (let g = 1; g <= 3; g++) {
      ctx.save();
      const s = 1 + 0.12 * g * st.ghost;
      ctx.translate(ax, ay);
      ctx.scale(s, s);
      ctx.translate(-ax, -ay);
      drawLines(0, t.color, 0.18 * st.ghost);
      ctx.restore();
    }
  }
  if (st.glitch > 0.01) {
    const off = (6 + 22 * hash01(frame, 4)) * st.glitch * k;
    drawLines(-off, '#ff0040', 0.8, 'lighter');
    drawLines(off, '#00e5ff', 0.8, 'lighter');
  }
  drawLines(0, null, 1);
  // glitch slices: shift random horizontal bands
  if (st.glitch > 0.05) {
    const c = ctx.canvas as HTMLCanvasElement;
    for (let i = 0; i < 4; i++) {
      const y = Math.floor((top + hash01(frame * 7 + i, 9) * blockH));
      const h = Math.max(2, Math.floor((4 + 26 * hash01(frame * 3 + i, 12)) * k));
      const dx = (hash01(frame * 5 + i, 13) - 0.5) * 80 * k * st.glitch;
      try {
        const img = ctx.getImageData(0, y, W, h);
        ctx.clearRect(0, y, W, h);
        ctx.putImageData(img, Math.round(dx), y);
      } catch {
        void c;
      }
    }
  }
  if (st.cursor && t.animIn === 'typewriter' && local < t.animInDuration + 0.6) {
    const li = lines.length - 1;
    const w = ctx.measureText(lines[li]).width;
    const x0 = t.align === 'center' ? ax - (widths[li] ?? 0) / 2 : t.align === 'right' ? ax - (widths[li] ?? 0) : left;
    ctx.fillStyle = t.color;
    ctx.fillRect(x0 + w + 4 * k, top + lh * li + lh * 0.15, size * 0.08, lh * 0.75);
  }
  if (sub) {
    ctx.font = font({ ...t, fontWeight: Math.min(800, t.fontWeight) }, subSize);
    ctx.fillStyle = t.subColor ?? t.color;
    const sy = top + lh * fullLines.length + subSize * 1.1;
    const sx = t.align === 'center' ? ax - subW / 2 : t.align === 'right' ? ax - subW : left;
    ctx.globalAlpha = st.alpha;
    if (t.outlineWidth > 0) {
      ctx.lineWidth = t.outlineWidth * k;
      ctx.strokeStyle = t.outlineColor;
      ctx.strokeText(sub, sx, sy);
    }
    ctx.fillText(sub, sx, sy);
  }
  ctx.restore();
}
