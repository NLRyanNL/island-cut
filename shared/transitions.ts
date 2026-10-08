// Transition catalogue: labels, categories, defaults, and the shape masks used by wipe-style
// transitions. The mask maths here is mirrored 1:1 by the preview shader (glCompositor) and the
// export (FFmpeg geq expression in render/buildGraph), so all three stay in sync.
import type { MaskKind, TransitionType } from './types';

export type TransitionCategory = 'Fade' | 'Slide & push' | 'Wipe' | 'Shape' | 'Zoom & spin' | 'Motion' | 'Stylized';

export interface TransitionInfo {
  id: TransitionType;
  label: string;
  category: TransitionCategory;
  /** Both clips are on screen for the whole transition window (incoming drawn on top). */
  overlap: boolean;
  /** Default duration in seconds. */
  duration: number;
  /** One-line description shown as a tooltip. */
  hint: string;
}

export const TRANSITIONS: TransitionInfo[] = [
  { id: 'crossfade', label: 'Crossfade', category: 'Fade', overlap: true, duration: 0.6, hint: 'Smoothly blend into the next clip' },
  { id: 'blurDissolve', label: 'Blur dissolve', category: 'Fade', overlap: true, duration: 0.7, hint: 'Dreamy blend through a soft blur' },
  { id: 'dipBlack', label: 'Fade through black', category: 'Fade', overlap: false, duration: 0.8, hint: 'Fade out to black, then into the next clip' },
  { id: 'dipWhite', label: 'Fade through white', category: 'Fade', overlap: false, duration: 0.8, hint: 'Fade out to white, then into the next clip' },
  { id: 'flash', label: 'Flash', category: 'Fade', overlap: false, duration: 0.3, hint: 'Quick white camera flash on the cut' },
  { id: 'lightLeak', label: 'Light leak', category: 'Fade', overlap: true, duration: 0.8, hint: 'Warm film light washes over the blend' },
  { id: 'filmBurn', label: 'Film burn', category: 'Fade', overlap: false, duration: 0.6, hint: 'Orange burn-out with grain' },

  { id: 'slideLeft', label: 'Slide left', category: 'Slide & push', overlap: true, duration: 0.5, hint: 'Next clip slides in from the right' },
  { id: 'slideRight', label: 'Slide right', category: 'Slide & push', overlap: true, duration: 0.5, hint: 'Next clip slides in from the left' },
  { id: 'slideUp', label: 'Slide up', category: 'Slide & push', overlap: true, duration: 0.5, hint: 'Next clip slides in from below' },
  { id: 'slideDown', label: 'Slide down', category: 'Slide & push', overlap: true, duration: 0.5, hint: 'Next clip slides in from above' },
  { id: 'pushLeft', label: 'Push left', category: 'Slide & push', overlap: true, duration: 0.5, hint: 'Next clip pushes the current one out to the left' },
  { id: 'pushRight', label: 'Push right', category: 'Slide & push', overlap: true, duration: 0.5, hint: 'Next clip pushes the current one out to the right' },
  { id: 'pushUp', label: 'Push up', category: 'Slide & push', overlap: true, duration: 0.5, hint: 'Next clip pushes the current one up' },
  { id: 'pushDown', label: 'Push down', category: 'Slide & push', overlap: true, duration: 0.5, hint: 'Next clip pushes the current one down' },

  { id: 'wipeLeft', label: 'Wipe left', category: 'Wipe', overlap: true, duration: 0.6, hint: 'Soft edge sweeps from right to left' },
  { id: 'wipeRight', label: 'Wipe right', category: 'Wipe', overlap: true, duration: 0.6, hint: 'Soft edge sweeps from left to right' },
  { id: 'wipeUp', label: 'Wipe up', category: 'Wipe', overlap: true, duration: 0.6, hint: 'Soft edge sweeps upwards' },
  { id: 'wipeDown', label: 'Wipe down', category: 'Wipe', overlap: true, duration: 0.6, hint: 'Soft edge sweeps downwards' },
  { id: 'wipeDiagonal', label: 'Diagonal wipe', category: 'Wipe', overlap: true, duration: 0.6, hint: 'Edge sweeps from the top-left corner' },
  { id: 'blinds', label: 'Blinds', category: 'Wipe', overlap: true, duration: 0.7, hint: 'Horizontal stripes open up' },
  { id: 'barsVertical', label: 'Bars', category: 'Wipe', overlap: true, duration: 0.7, hint: 'Vertical bars open up' },

  { id: 'iris', label: 'Circle reveal', category: 'Shape', overlap: true, duration: 0.7, hint: 'Circle grows from the centre' },
  { id: 'diamond', label: 'Diamond reveal', category: 'Shape', overlap: true, duration: 0.7, hint: 'Diamond grows from the centre' },
  { id: 'clockWipe', label: 'Clock wipe', category: 'Shape', overlap: true, duration: 0.8, hint: 'Sweeps around like a clock hand' },

  { id: 'zoomIn', label: 'Zoom in', category: 'Zoom & spin', overlap: true, duration: 0.5, hint: 'Next clip zooms in from the centre' },
  { id: 'zoomPunch', label: 'Zoom punch', category: 'Zoom & spin', overlap: false, duration: 0.35, hint: 'Hard cut that lands with a punch-in' },
  { id: 'zoomBlur', label: 'Zoom blur', category: 'Zoom & spin', overlap: false, duration: 0.5, hint: 'Rush into the cut with motion blur' },
  { id: 'spin', label: 'Spin', category: 'Zoom & spin', overlap: false, duration: 0.6, hint: 'Spin out and back in with blur' },

  { id: 'whipPan', label: 'Whip left', category: 'Motion', overlap: false, duration: 0.4, hint: 'Fast camera whip to the left' },
  { id: 'whipRight', label: 'Whip right', category: 'Motion', overlap: false, duration: 0.4, hint: 'Fast camera whip to the right' },
  { id: 'whipUp', label: 'Whip up', category: 'Motion', overlap: false, duration: 0.4, hint: 'Fast camera whip upwards' },
  { id: 'whipDown', label: 'Whip down', category: 'Motion', overlap: false, duration: 0.4, hint: 'Fast camera whip downwards' },
  { id: 'shakeCut', label: 'Impact shake', category: 'Motion', overlap: false, duration: 0.4, hint: 'Cut with a heavy camera hit' },

  { id: 'glitch', label: 'Glitch', category: 'Stylized', overlap: true, duration: 0.3, hint: 'Digital glitch flickers between the clips' },
  { id: 'rgbSplit', label: 'RGB split', category: 'Stylized', overlap: false, duration: 0.35, hint: 'Colour channels tear apart on the cut' },
];

export const TRANSITION_CATEGORIES: TransitionCategory[] = ['Fade', 'Slide & push', 'Wipe', 'Shape', 'Zoom & spin', 'Motion', 'Stylized'];

const BY_ID = new Map(TRANSITIONS.map((t) => [t.id, t]));

export function transitionInfo(id: TransitionType): TransitionInfo | undefined {
  return BY_ID.get(id);
}

export function transitionLabel(id: TransitionType): string {
  return BY_ID.get(id)?.label ?? id;
}

export function isOverlapTransition(id: TransitionType): boolean {
  return BY_ID.get(id)?.overlap ?? false;
}

export function defaultTransitionDuration(id: TransitionType): number {
  return BY_ID.get(id)?.duration ?? 0.5;
}

export function isTransitionType(x: unknown): x is TransitionType {
  return typeof x === 'string' && BY_ID.has(x as TransitionType);
}

// ------------------------------------------------------------------ masks

/** A reveal mask for the incoming clip. Coordinates are layer-local (0..1). */
export interface MaskState {
  kind: MaskKind;
  /** progress 0 (nothing visible) .. 1 (fully visible) */
  p: number;
  /** linear: direction of travel in degrees (0 = left→right, 90 = top→bottom) */
  angle: number;
  /** soft edge width, in normalized distance units */
  feather: number;
  /** bands: number of stripes; angle 90 = horizontal stripes, 0 = vertical bars */
  bands: number;
}

export const MASK_KIND_ID: Record<MaskKind, number> = { linear: 1, circle: 2, diamond: 3, clock: 4, bands: 5 };

/**
 * Distance field of a mask at layer pixel (x, y) of a w×h layer, normalized so it runs from 0
 * (revealed first) to 1 (revealed last). Mirrored by the shader and the geq expression.
 */
export function maskDistance(m: MaskState, x: number, y: number, w: number, h: number): number {
  const u = x / w;
  const v = y / h;
  switch (m.kind) {
    case 'linear': {
      const a = (m.angle * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const r = 0.5 * (Math.abs(c) + Math.abs(s));
      return ((u - 0.5) * c + (v - 0.5) * s + r) / (2 * r);
    }
    case 'circle':
      return Math.hypot(x - w / 2, y - h / 2) / (0.5 * Math.hypot(w, h));
    case 'diamond':
      return Math.abs(u - 0.5) + Math.abs(v - 0.5);
    case 'clock': {
      // angle from 12 o'clock, clockwise
      const ang = Math.atan2(x - w / 2, -(y - h / 2));
      return (ang / (2 * Math.PI) + 1) % 1;
    }
    case 'bands': {
      const q = m.angle === 90 ? v : u;
      const f = q * m.bands;
      return f - Math.floor(f);
    }
  }
}

/** Visibility 0..1 at a pixel: soft edge sweeping through the distance field as p goes 0 → 1. */
export function maskValue(m: MaskState, x: number, y: number, w: number, h: number): number {
  const d = maskDistance(m, x, y, w, h);
  const f = Math.max(1e-4, m.feather);
  const edge = -f + m.p * (1 + 2 * f);
  return Math.min(1, Math.max(0, (edge - d) / f));
}
