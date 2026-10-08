import type { AnimProp, Clip, Ease, Keyframe } from './types';
import { clamp } from './time';

export function ease(e: Ease, k: number): number {
  k = clamp(k, 0, 1);
  switch (e) {
    case 'linear':
      return k;
    case 'easeIn':
      return k * k * k;
    case 'easeOut':
      return 1 - Math.pow(1 - k, 3);
    case 'easeInOut':
      return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    case 'hold':
      return 0;
  }
}

export function sortKeys(keys: Keyframe[]): Keyframe[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** Evaluate keyframes at clip-local time t. The ease of a key controls the segment that starts at it. */
export function evalKeys(keys: Keyframe[], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  // binary search
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const k = ease(a.ease, (t - a.t) / span);
  return a.v + (b.v - a.v) * k;
}

export function isAnimated(p: AnimProp | undefined): boolean {
  return !!p && !!p.keys && p.keys.length >= 2;
}

export function evalProp(p: AnimProp, t: number): number {
  if (p.keys && p.keys.length >= 2) return evalKeys(p.keys, t);
  if (p.keys && p.keys.length === 1) return p.keys[0].v;
  return p.value;
}

export function constProp(v: number): AnimProp {
  return { value: v };
}

/** Insert or replace a keyframe at time t (within half a frame). */
export function setKey(p: AnimProp, t: number, v: number, easeType: Ease = 'easeInOut', tol = 1 / 120): AnimProp {
  const keys = [...(p.keys ?? [])];
  if (keys.length === 0) {
    // First key: also anchor the current constant value is not needed; single key acts as constant.
    keys.push({ t, v, ease: easeType });
    return { value: v, keys };
  }
  const i = keys.findIndex((k) => Math.abs(k.t - t) <= tol);
  if (i >= 0) keys[i] = { ...keys[i], v };
  else keys.push({ t, v, ease: easeType });
  return { value: p.value, keys: sortKeys(keys) };
}

export function removeKeyNear(p: AnimProp, t: number, tol = 1 / 120): AnimProp {
  const keys = (p.keys ?? []).filter((k) => Math.abs(k.t - t) > tol);
  const value = keys.length === 1 ? keys[0].v : p.value;
  return { value, keys: keys.length ? keys : undefined };
}

export function keyNear(p: AnimProp, t: number, tol = 1 / 120): Keyframe | undefined {
  return (p.keys ?? []).find((k) => Math.abs(k.t - t) <= tol);
}

// ---------------- Speed / time remapping ----------------

const RAMP_STEP = 1 / 480;
const rampCache = new Map<string, Float64Array>();

function rampSig(clip: Clip): string {
  return JSON.stringify(clip.speedKeys) + '|' + clip.duration.toFixed(6);
}

export function hasRamp(clip: Clip): boolean {
  return !!clip.speedKeys && clip.speedKeys.length >= 2;
}

/** Instantaneous speed at clip-local time. */
export function speedAt(clip: Clip, local: number): number {
  if (hasRamp(clip)) return Math.max(0.05, evalKeys(clip.speedKeys!, local));
  return clip.speed || 1;
}

/** Cumulative integral table of the speed curve, sampled every RAMP_STEP seconds. */
function rampTable(clip: Clip): Float64Array {
  const sig = rampSig(clip);
  let tab = rampCache.get(sig);
  if (tab) return tab;
  const n = Math.ceil(clip.duration / RAMP_STEP) + 2;
  tab = new Float64Array(n);
  let acc = 0;
  tab[0] = 0;
  for (let i = 1; i < n; i++) {
    const t0 = (i - 1) * RAMP_STEP;
    const t1 = i * RAMP_STEP;
    acc += ((speedAt(clip, t0) + speedAt(clip, t1)) / 2) * RAMP_STEP;
    tab[i] = acc;
  }
  if (rampCache.size > 500) rampCache.clear();
  rampCache.set(sig, tab);
  return tab;
}

/** Source seconds consumed from clip start to clip-local time `local`. */
export function sourceOffsetAt(clip: Clip, local: number): number {
  if (!hasRamp(clip)) return local * (clip.speed || 1);
  const tab = rampTable(clip);
  const f = local / RAMP_STEP;
  const i = Math.floor(f);
  if (i < 0) return 0;
  if (i >= tab.length - 1) return tab[tab.length - 1];
  return tab[i] + (tab[i + 1] - tab[i]) * (f - i);
}

/** Source time (seconds in the media file) shown at clip-local time. */
export function sourceTimeAt(clip: Clip, local: number): number {
  return clip.in + sourceOffsetAt(clip, local);
}

/** Total source span used by the clip. */
export function sourceSpan(clip: Clip): number {
  return sourceOffsetAt(clip, clip.duration);
}

/** Inverse mapping: clip-local time at which source offset `off` is displayed. */
export function localTimeForSourceOffset(clip: Clip, off: number): number {
  if (!hasRamp(clip)) return off / (clip.speed || 1);
  let lo = 0;
  let hi = clip.duration;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sourceOffsetAt(clip, mid) < off) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
