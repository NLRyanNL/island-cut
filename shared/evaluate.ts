// Evaluates what every visual layer looks like at a given timeline time.
// The SAME functions drive the WebGL preview and the FFmpeg export (which samples them per frame),
// so preview and export stay consistent.
import type { Clip, MediaItem, Project, Track, TransitionType } from './types';
import { evalProp, sourceTimeAt, hasRamp, sourceSpan } from './keyframes';
import { clamp, EPS } from './time';
import { clipEnd, clipsOnTrack } from './timelineOps';
import { isOverlapTransition, type MaskState } from './transitions';

export interface LayerState {
  clip: Clip;
  track: Track;
  /** z-order: higher draws on top */
  z: number;
  /** clip-local time (may be slightly negative / beyond duration during transitions) */
  local: number;
  /** source time in seconds (video/audio) */
  srcTime: number;
  /** displayed size in output pixels (before rotation) */
  w: number;
  h: number;
  /** center in output pixels */
  cx: number;
  cy: number;
  rotation: number; // degrees
  opacity: number;
  blur: number; // gaussian sigma in output px
  blurHorizontalOnly: boolean;
  rgbShift: number; // px
  dipColor: [number, number, number];
  dipAmount: number;
  noise: number; // 0..1
  /** wipe/shape reveal mask (layer-local), when a transition uses one */
  mask?: MaskState;
}

export interface TransitionWindow {
  /** clip that transitions out (may be null for intro transitions) */
  a: Clip | null;
  b: Clip;
  type: TransitionType;
  start: number;
  end: number;
  cut: number;
}

/** Natural pixel size of the clip's content. */
export function contentSize(p: Project, c: Clip): { w: number; h: number } {
  if (c.kind === 'text' || c.kind === 'adjust') return { w: p.settings.width, h: p.settings.height };
  const m = c.mediaId ? p.media[c.mediaId] : undefined;
  if (m && m.width > 0 && m.height > 0) return { w: m.width, h: m.height };
  return { w: p.settings.width, h: p.settings.height };
}

/** Find the transition window that involves clip c as the incoming clip. */
export function incomingTransition(p: Project, c: Clip, fps: number): TransitionWindow | null {
  if (!c.transitionIn || c.transitionIn.duration <= EPS) return null;
  const d = Math.min(c.transitionIn.duration, c.duration);
  const prev = previousAdjacent(p, c, fps);
  if (prev) {
    const half = Math.min(d / 2, prev.duration, c.duration);
    return { a: prev, b: c, type: c.transitionIn.type, start: c.start - half, end: c.start + half, cut: c.start };
  }
  return { a: null, b: c, type: c.transitionIn.type, start: c.start, end: c.start + d, cut: c.start };
}

export function previousAdjacent(p: Project, c: Clip, fps: number): Clip | null {
  const tol = 0.5 / fps;
  for (const o of Object.values(p.clips)) {
    if (o.trackId !== c.trackId || o.id === c.id) continue;
    if (Math.abs(clipEnd(o) - c.start) <= tol) return o;
  }
  return null;
}

export function nextAdjacent(p: Project, c: Clip, fps: number): Clip | null {
  const tol = 0.5 / fps;
  for (const o of Object.values(p.clips)) {
    if (o.trackId !== c.trackId || o.id === c.id) continue;
    if (Math.abs(o.start - clipEnd(c)) <= tol) return o;
  }
  return null;
}

/** The time range in which a clip contributes pixels, including transition overlaps. */
export function activeRange(p: Project, c: Clip): { a: number; b: number; pre: number; post: number } {
  const fps = p.settings.fps;
  let pre = 0;
  let post = 0;
  const tin = incomingTransition(p, c, fps);
  if (tin && tin.a && isOverlapTransition(tin.type)) pre = c.start - tin.start;
  const next = nextAdjacent(p, c, fps);
  if (next) {
    const tn = incomingTransition(p, next, fps);
    if (tn && tn.a?.id === c.id && isOverlapTransition(tn.type)) post = tn.end - next.start;
  }
  return { a: c.start - pre, b: clipEnd(c) + post, pre, post };
}

function smooth(k: number): number {
  k = clamp(k, 0, 1);
  return k * k * (3 - 2 * k);
}

function easeInCubic(k: number): number {
  k = clamp(k, 0, 1);
  return k * k * k;
}

function easeOutCubic(k: number): number {
  k = clamp(k, 0, 1);
  return 1 - Math.pow(1 - k, 3);
}

/** Deterministic pseudo-random in [0,1) from an integer + seed. */
export function hash01(n: number, seed = 0): number {
  let x = (n * 374761393 + seed * 668265263) | 0;
  x = (x ^ (x >>> 13)) * 1274126177;
  x = x ^ (x >>> 16);
  return ((x >>> 0) % 100000) / 100000;
}

/** Smooth noise in [-1,1] built from incommensurate sines. */
export function shakeNoise(t: number, seed: number): number {
  return (
    0.55 * Math.sin(t * 1.0 + seed * 1.7) +
    0.3 * Math.sin(t * 2.31 + seed * 3.1) +
    0.15 * Math.sin(t * 5.17 + seed * 0.3)
  );
}

interface FxAccum {
  scaleMul: number;
  dx: number;
  dy: number;
  rot: number;
  opacityMul: number;
  blur: number;
  blurH: boolean;
  rgbShift: number;
  dipColor: [number, number, number];
  dipAmount: number;
  noise: number;
  hidden: boolean;
  mask?: MaskState;
}

function newFx(): FxAccum {
  return {
    scaleMul: 1,
    dx: 0,
    dy: 0,
    rot: 0,
    opacityMul: 1,
    blur: 0,
    blurH: false,
    rgbShift: 0,
    dipColor: [0, 0, 0],
    dipAmount: 0,
    noise: 0,
    hidden: false,
  };
}

/** Apply the outgoing (role 'a') or incoming (role 'b') half of a transition at time t. */
function applyTransition(fx: FxAccum, w: TransitionWindow, role: 'a' | 'b', t: number, W: number, H: number, fps: number): void {
  const len = Math.max(EPS, w.end - w.start);
  const p = clamp((t - w.start) / len, 0, 1);
  const intro = w.a === null;
  const frameIdx = Math.round(t * fps);
  const sW = W / 1920;
  const sH = H / 1080;
  // cut-based transitions: A plays until the cut, B from the cut; q = progress of B's half
  const beforeCut = t < w.cut;
  const cutHide = () => {
    if (role === 'a' && !beforeCut) fx.hidden = true;
    if (role === 'b' && beforeCut && !intro) fx.hidden = true;
  };
  const qA = clamp(p * 2, 0, 1); // 0..1 over A's half
  const qB = intro ? p : clamp((p - 0.5) * 2, 0, 1); // 0..1 over B's half
  const dip = (col: [number, number, number], amount: number) => {
    fx.dipColor = col;
    fx.dipAmount = Math.max(fx.dipAmount, clamp(amount, 0, 1));
  };
  const e = smooth(p);
  const mask = (kind: MaskState['kind'], angle: number, feather: number, bands = 1) => {
    if (role === 'b') fx.mask = { kind, p: e, angle, feather, bands };
  };
  const slide = (dx: number, dy: number, push: boolean) => {
    const k = easeInOutCubic(p);
    if (role === 'b') {
      fx.dx += dx * W * (1 - k);
      fx.dy += dy * H * (1 - k);
    } else if (push) {
      fx.dx -= dx * W * k;
      fx.dy -= dy * H * k;
    }
  };
  const whip = (dx: number, dy: number) => {
    cutHide();
    const k = role === 'a' ? easeInCubic(qA) : 1 - easeOutCubic(qB);
    const sgn = role === 'a' ? -1 : 1;
    fx.dx += sgn * dx * W * 0.9 * k;
    fx.dy += sgn * dy * H * 0.9 * k;
    if (dy === 0) {
      fx.blur = Math.max(fx.blur, 60 * k * sW);
      fx.blurH = true;
    } else {
      fx.blur = Math.max(fx.blur, 40 * k * sH);
    }
  };
  switch (w.type) {
    // ---------------------------------------------------------------- fades
    case 'crossfade':
      if (role === 'b') fx.opacityMul *= e;
      break;
    case 'blurDissolve': {
      if (role === 'b') fx.opacityMul *= e;
      fx.blur = Math.max(fx.blur, 22 * Math.sin(Math.PI * p) * sH);
      break;
    }
    case 'lightLeak': {
      if (role === 'b') fx.opacityMul *= e;
      dip([1, 0.62, 0.28], 0.6 * Math.sin(Math.PI * p));
      fx.scaleMul *= 1 + 0.03 * Math.sin(Math.PI * p);
      break;
    }
    case 'dipBlack':
    case 'dipWhite': {
      const col: [number, number, number] = w.type === 'dipBlack' ? [0, 0, 0] : [1, 1, 1];
      if (intro) {
        if (role === 'b') dip(col, 1 - smooth(p));
        break;
      }
      cutHide();
      if (role === 'a') dip(col, smooth(qA));
      else dip(col, 1 - smooth(qB));
      break;
    }
    case 'flash': {
      cutHide();
      if (role === 'a') dip([1, 1, 1], easeInCubic((p - 0.2) / 0.3));
      else dip([1, 1, 1], 1 - easeOutCubic(qB));
      break;
    }
    case 'filmBurn': {
      cutHide();
      const amt = role === 'a' ? easeInCubic(qA) : 1 - easeOutCubic(qB);
      dip([1, 0.42 + 0.3 * amt, 0.08 + 0.2 * amt], amt * 0.95);
      fx.noise = Math.max(fx.noise, 0.5 * amt);
      fx.scaleMul *= 1 + 0.04 * amt;
      break;
    }
    // ---------------------------------------------------------------- slide & push
    case 'slideLeft':
      slide(1, 0, false);
      break;
    case 'slideRight':
      slide(-1, 0, false);
      break;
    case 'slideUp':
      slide(0, 1, false);
      break;
    case 'slideDown':
      slide(0, -1, false);
      break;
    case 'pushLeft':
      slide(1, 0, true);
      break;
    case 'pushRight':
      slide(-1, 0, true);
      break;
    case 'pushUp':
      slide(0, 1, true);
      break;
    case 'pushDown':
      slide(0, -1, true);
      break;
    // ---------------------------------------------------------------- wipes & shapes
    case 'wipeRight':
      mask('linear', 0, 0.08);
      break;
    case 'wipeLeft':
      mask('linear', 180, 0.08);
      break;
    case 'wipeDown':
      mask('linear', 90, 0.08);
      break;
    case 'wipeUp':
      mask('linear', 270, 0.08);
      break;
    case 'wipeDiagonal':
      mask('linear', 45, 0.1);
      break;
    case 'blinds':
      mask('bands', 90, 0.12, 8);
      break;
    case 'barsVertical':
      mask('bands', 0, 0.12, 10);
      break;
    case 'iris':
      mask('circle', 0, 0.05);
      break;
    case 'diamond':
      mask('diamond', 0, 0.05);
      break;
    case 'clockWipe':
      mask('clock', 0, 0.02);
      break;
    // ---------------------------------------------------------------- zoom & spin
    case 'zoomIn': {
      if (role === 'b') {
        fx.scaleMul *= 0.35 + 0.65 * easeOutCubic(p);
        fx.opacityMul *= smooth(p * 2.5);
      } else {
        fx.scaleMul *= 1 + 0.25 * easeInCubic(p);
      }
      break;
    }
    case 'zoomPunch': {
      cutHide();
      if (role === 'a') fx.scaleMul *= 1 + 0.1 * easeInCubic(qA);
      else {
        const k = 1 - easeOutCubic(qB);
        fx.scaleMul *= 1 + 0.28 * k;
        dip([1, 1, 1], 0.35 * k * k);
      }
      break;
    }
    case 'zoomBlur': {
      cutHide();
      if (role === 'a') {
        const k = easeInCubic(qA);
        fx.scaleMul *= 1 + 0.5 * k;
        fx.blur = Math.max(fx.blur, 26 * k * sH);
      } else {
        const k = 1 - easeOutCubic(qB);
        fx.scaleMul *= 1 + 0.5 * k;
        fx.blur = Math.max(fx.blur, 26 * k * sH);
        if (intro) fx.opacityMul *= smooth(qB * 2);
      }
      break;
    }
    case 'spin': {
      cutHide();
      const k = role === 'a' ? easeInCubic(qA) : 1 - easeOutCubic(qB);
      fx.rot += (role === 'a' ? 1 : -1) * 200 * k;
      fx.scaleMul *= 1 + 0.6 * k;
      fx.blur = Math.max(fx.blur, 18 * k * sH);
      if (intro && role === 'b') fx.opacityMul *= smooth(qB * 2);
      break;
    }
    // ---------------------------------------------------------------- motion
    case 'whipPan':
      whip(1, 0);
      break;
    case 'whipRight':
      whip(-1, 0);
      break;
    case 'whipUp':
      whip(0, 1);
      break;
    case 'whipDown':
      whip(0, -1);
      break;
    case 'shakeCut': {
      cutHide();
      const amp = role === 'a' ? 0.25 * easeInCubic(qA) : Math.pow(1 - qB, 2);
      fx.dx += (hash01(frameIdx, 21) - 0.5) * 2 * 60 * sW * amp;
      fx.dy += (hash01(frameIdx, 22) - 0.5) * 2 * 40 * sH * amp;
      fx.rot += (hash01(frameIdx, 23) - 0.5) * 4 * amp;
      fx.scaleMul *= 1 + 0.08 * amp;
      fx.blur = Math.max(fx.blur, 6 * amp * sH);
      break;
    }
    // ---------------------------------------------------------------- stylized
    case 'rgbSplit': {
      cutHide();
      const bump = 1 - Math.abs(2 * p - 1);
      fx.rgbShift = Math.max(fx.rgbShift, 46 * bump * sW);
      fx.scaleMul *= 1 + 0.05 * bump;
      fx.dx += (hash01(frameIdx, 31) - 0.5) * 24 * bump * sW;
      break;
    }
    case 'glitch': {
      const bump = Math.sin(Math.PI * p);
      const r = hash01(frameIdx, 11);
      fx.rgbShift = Math.max(fx.rgbShift, (8 + 26 * r) * bump * sW);
      fx.noise = Math.max(fx.noise, 0.35 * bump);
      fx.dx += (hash01(frameIdx, 5) - 0.5) * 40 * bump * sW;
      // random toggling between A and B around the cut
      const showB = p > 0.5 ? hash01(frameIdx, 7) > 0.25 * (1 - (p - 0.5) * 2) : hash01(frameIdx, 7) < 0.6 * p;
      if (intro) {
        if (role === 'b') fx.opacityMul *= hash01(frameIdx, 3) < p * 1.3 ? 1 : 0;
      } else if (role === 'a') {
        if (showB) fx.hidden = true;
      } else if (!showB) fx.hidden = true;
      break;
    }
  }
}

function easeInOutCubic(k: number): number {
  k = clamp(k, 0, 1);
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

/** Picture fade in/out at the clip's own start/end (to a colour, or to transparent). */
function applyVideoFades(fx: FxAccum, c: Clip, local: number): void {
  const fi = c.videoFadeIn ?? 0;
  const fo = c.videoFadeOut ?? 0;
  if (fi <= EPS && fo <= EPS) return;
  if (local < 0 || local > c.duration) return; // transition overlap time is the transition's business
  let k = 1;
  if (fi > EPS && local < fi) k = Math.min(k, clamp(local / fi, 0, 1));
  if (fo > EPS && local > c.duration - fo) k = Math.min(k, clamp((c.duration - local) / fo, 0, 1));
  if (k >= 1) return;
  const color = c.fadeColor ?? (c.kind === 'video' ? 'black' : 'transparent');
  if (color === 'transparent') fx.opacityMul *= smooth(k);
  else {
    fx.dipColor = color === 'white' ? [1, 1, 1] : [0, 0, 0];
    fx.dipAmount = Math.max(fx.dipAmount, 1 - smooth(k));
  }
}

export interface EvalOptions {
  /** Include hidden tracks (export ignores hidden tracks; never true in practice). */
  includeHidden?: boolean;
}

/** Geometry before transitions/shake: base fit size and center. */
export function baseGeometry(p: Project, c: Clip, local: number): { w: number; h: number; cx: number; cy: number; rotation: number; opacity: number } {
  const W = p.settings.width;
  const H = p.settings.height;
  const { w: mw, h: mh } = contentSize(p, c);
  let sx: number;
  let sy: number;
  if (c.kind === 'text' || c.kind === 'adjust') {
    sx = sy = 1;
  } else if (c.fit === 'stretch') {
    sx = W / mw;
    sy = H / mh;
  } else {
    const s = c.fit === 'fit' ? Math.min(W / mw, H / mh) : Math.max(W / mw, H / mh);
    sx = sy = s;
  }
  const us = Math.max(0.001, evalProp(c.transform.scale, local));
  const w = mw * sx * us;
  const h = mh * sy * us;
  let ox = evalProp(c.transform.x, local);
  let oy = evalProp(c.transform.y, local);
  if (c.reframe?.enabled) {
    const fx = evalProp(c.reframe.focusX, local);
    const fy = evalProp(c.reframe.focusY, local);
    let rx = (0.5 - fx) * w;
    let ry = (0.5 - fy) * h;
    const mx = Math.max(0, (w - W) / 2);
    const my = Math.max(0, (h - H) / 2);
    rx = clamp(rx, -mx, mx);
    ry = clamp(ry, -my, my);
    ox += rx;
    oy += ry;
  }
  return {
    w,
    h,
    cx: W / 2 + ox,
    cy: H / 2 + oy,
    rotation: evalProp(c.transform.rotation, local),
    opacity: clamp(evalProp(c.transform.opacity, local), 0, 1),
  };
}

export function sourceTimeClamped(p: Project, c: Clip, local: number): number {
  const m = c.mediaId ? p.media[c.mediaId] : undefined;
  let s: number;
  if (local > c.duration && hasRamp(c)) s = c.in + sourceSpan(c) + (local - c.duration) * (c.speedKeys![c.speedKeys!.length - 1].v || 1);
  else if (local < 0) s = c.in + local * (hasRamp(c) ? c.speedKeys![0].v : c.speed || 1);
  else s = sourceTimeAt(c, local);
  const maxT = m && m.duration > 0 ? m.duration - 1 / Math.max(1, m.fps || 30) : Infinity;
  return clamp(s, 0, Math.max(0, maxT));
}

/** Evaluate one clip at time t, or null if it contributes nothing. */
export function evaluateClip(p: Project, c: Clip, track: Track, z: number, t: number): LayerState | null {
  const fps = p.settings.fps;
  const W = p.settings.width;
  const H = p.settings.height;
  // cheap reject first: transitions never reach further than a few seconds outside the clip
  if (t < c.start - 5 || t > c.start + c.duration + 5) return null;
  const r = activeRange(p, c);
  if (t < r.a - EPS || t >= r.b - EPS) return null;
  const local = t - c.start;
  const g = baseGeometry(p, c, clamp(local, 0, c.duration));
  const fx = newFx();

  // transitions
  const tin = incomingTransition(p, c, fps);
  if (tin && t >= tin.start - EPS && t < tin.end) applyTransition(fx, tin, 'b', t, W, H, fps);
  const next = nextAdjacent(p, c, fps);
  if (next) {
    const tn = incomingTransition(p, next, fps);
    if (tn && tn.a?.id === c.id && t >= tn.start - EPS && t < tn.end) applyTransition(fx, tn, 'a', t, W, H, fps);
  }
  if (fx.hidden) return null;
  applyVideoFades(fx, c, local);
  if (c.blur && c.blur > 0.05) fx.blur = Math.max(fx.blur, c.blur * (H / 1080));

  // camera shake
  for (const s of c.shakes) {
    if (local < s.at || local > s.at + s.duration) continue;
    const u = (local - s.at) / Math.max(EPS, s.duration);
    const env = Math.pow(1 - u, 2) * clamp(u * 12, 0, 1);
    const I = s.intensity * env;
    const f = s.frequency * Math.PI * 2;
    fx.dx += I * W * 0.035 * shakeNoise(local * f, 1);
    fx.dy += I * H * 0.035 * shakeNoise(local * f, 2);
    fx.rot += I * 2.2 * shakeNoise(local * f * 0.8, 3);
    fx.scaleMul *= 1 + 0.08 * I;
  }

  return {
    clip: c,
    track,
    z,
    local,
    srcTime: c.kind === 'video' || c.kind === 'audio' ? sourceTimeClamped(p, c, local) : 0,
    w: g.w * fx.scaleMul,
    h: g.h * fx.scaleMul,
    cx: g.cx + fx.dx,
    cy: g.cy + fx.dy,
    rotation: g.rotation + fx.rot,
    opacity: clamp(g.opacity * fx.opacityMul, 0, 1),
    blur: fx.blur,
    blurHorizontalOnly: fx.blurH,
    rgbShift: fx.rgbShift,
    dipColor: fx.dipColor,
    dipAmount: clamp(fx.dipAmount, 0, 1),
    noise: fx.noise,
    mask: fx.mask,
  };
}

/** Visual tracks in bottom-to-top compositing order (V1 first, text last). */
export function visualTracksBottomUp(p: Project): Track[] {
  const vis = p.tracks.filter((t) => t.kind === 'video' || t.kind === 'text');
  // array order is top->bottom (text first, then V4..V1); reverse it
  return [...vis].reverse();
}

/** All visible layers at time t, bottom to top. */
export function layersAt(p: Project, t: number): LayerState[] {
  const out: LayerState[] = [];
  const tracks = visualTracksBottomUp(p);
  tracks.forEach((tr, ti) => {
    if (tr.hidden) return;
    const clips = clipsOnTrack(p, tr.id);
    // within a track, incoming clips of a crossfade draw above outgoing ones (later start = higher)
    clips.forEach((c, ci) => {
      if (c.kind === 'audio') return;
      const s = evaluateClip(p, c, tr, ti * 10000 + ci, t);
      if (s && s.opacity > 0.001) out.push(s);
    });
  });
  return out.sort((a, b) => a.z - b.z);
}

/** Audio-producing clips at time t (audio clips + video clips that still carry their audio). */
export function clipHasAudio(p: Project, c: Clip): boolean {
  if (c.kind === 'audio') return true;
  if (c.kind !== 'video' || c.audioDetached) return false;
  const m: MediaItem | undefined = c.mediaId ? p.media[c.mediaId] : undefined;
  return !!m?.hasAudio;
}
