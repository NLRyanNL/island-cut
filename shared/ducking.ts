// Auto-ducking: music gets quieter while voice/SFX tracks have sound.
// Activity is detected from each clip's waveform peaks; the result is a smooth gain curve
// (attack/release ramps) used by both the preview mixer and the export.
import type { Project, WaveformData } from './types';
import { clipHasAudio } from './evaluate';
import { clipEnd } from './timelineOps';
import { sourceTimeAt } from './keyframes';
import { dbToGain } from './time';

export interface DuckInterval {
  a: number;
  b: number;
}

export function computeDuckIntervals(p: Project, waveforms: Record<string, WaveformData | undefined>): DuckInterval[] {
  const s = p.settings;
  const thr = dbToGain(s.duckThresholdDb);
  const raw: DuckInterval[] = [];
  const triggerTracks = new Set(p.tracks.filter((t) => t.kind === 'audio' && !t.muted && (t.role === 'voice' || t.role === 'sfx')).map((t) => t.id));
  for (const c of Object.values(p.clips)) {
    if (!triggerTracks.has(c.trackId) || c.muted || !clipHasAudio(p, c)) continue;
    const m = c.mediaId ? p.media[c.mediaId] : undefined;
    const wf = m ? waveforms[m.path] : undefined;
    if (!wf) {
      // unknown waveform: treat the whole clip as active
      raw.push({ a: c.start, b: clipEnd(c) });
      continue;
    }
    const step = 0.05;
    let runStart = -1;
    for (let t = c.start; t < clipEnd(c); t += step) {
      const src = sourceTimeAt(c, t - c.start);
      const i = Math.floor(src * wf.peaksPerSec);
      let pk = 0;
      for (let j = i; j < i + Math.ceil(wf.peaksPerSec * step); j++) pk = Math.max(pk, wf.peaks[j] ?? 0);
      const active = pk * c.volume >= thr;
      if (active && runStart < 0) runStart = t;
      if (!active && runStart >= 0) {
        raw.push({ a: runStart, b: t });
        runStart = -1;
      }
    }
    if (runStart >= 0) raw.push({ a: runStart, b: clipEnd(c) });
  }
  raw.sort((x, y) => x.a - y.a);
  // merge intervals separated by short gaps
  const merged: DuckInterval[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.a - last.b < 0.35) last.b = Math.max(last.b, r.b);
    else merged.push({ ...r });
  }
  return merged;
}

/** Gain multiplier (0..1) for music at time t. */
export function duckGainAt(p: Project, intervals: DuckInterval[], t: number): number {
  const s = p.settings;
  if (!s.duckingEnabled || !intervals.length) return 1;
  const att = Math.max(0.01, s.duckAttack);
  const rel = Math.max(0.01, s.duckRelease);
  let env = 0;
  for (const iv of intervals) {
    if (t < iv.a - att || t > iv.b + rel) continue;
    let e: number;
    if (t < iv.a) e = (t - (iv.a - att)) / att;
    else if (t <= iv.b) e = 1;
    else e = 1 - (t - iv.b) / rel;
    if (e > env) env = e;
    if (env >= 1) break;
  }
  const floor = dbToGain(-Math.abs(s.duckAmountDb));
  return 1 - (1 - floor) * env;
}
