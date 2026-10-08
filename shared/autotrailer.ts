// Auto Trailer: turns analyzed footage + a style description into an editable concept,
// then builds a real, editable timeline from that concept.
import type { AspectId, Clip, LookId, MediaItem, Project, TextAnimation, TransitionType } from './types';
import { TRANSITIONS, defaultTransitionDuration, isTransitionType } from './transitions';
import type { FootageAnalysis, HudBox } from './analysis';
import { ASPECTS, createProject, defaultAdjust, defaultText, makeClip, clipFromMedia } from './defaults';
import { addMarker, placeClip, tracksOfKind, addTrack, isRangeFree } from './timelineOps';
import { snapFrame, uid, clamp } from './time';

export type TrailerMode = 'gameplay' | 'cinematic';
export type Mood = 'hype' | 'horror' | 'epic' | 'fun' | 'mystery' | 'chill';
export type Pacing = 'slow' | 'medium' | 'fast';

export interface TrailerStyle {
  mode: TrailerMode;
  duration: number;
  aspect: AspectId;
  mood: Mood;
  pacing: Pacing;
  title: string;
  tagline: string;
  islandCode: string;
  features: string[];
  look: LookId;
  letterbox: boolean;
  slowMo: boolean;
  beatSync: boolean;
  endCard: 'playNow' | 'comingSoon' | 'both';
}

export interface ConceptSection {
  id: string;
  name: string;
  duration: number;
  /** average shot length in seconds */
  shotLength: number;
  /** 0 = calm/atmospheric shots, 1 = maximum action */
  energy: number;
  transition: TransitionType | null;
  text?: { text: string; sub?: string; preset: string };
  speed: number;
  endCard?: boolean;
  notes?: string;
}

export interface ShotCandidate {
  id: string;
  mediaId: string;
  mediaName: string;
  srcIn: number;
  length: number;
  motion: number;
  loudness: number;
  peaks: number;
  hud: number;
  gunfire: number;
  dark: boolean;
  flat: boolean;
  action: number;
  calm: number;
  quality: number;
  flags: string[];
  aiNote?: string;
}

export interface ConceptShot {
  candidateId: string;
  sectionId: string;
  include: boolean;
  /** preferred length on the timeline (seconds) */
  length: number;
}

export interface TrailerConcept {
  version: 1;
  title: string;
  logline: string;
  style: TrailerStyle;
  musicMediaId?: string;
  sections: ConceptSection[];
  shots: ConceptShot[];
  candidates: ShotCandidate[];
  notes: string[];
  source: 'local' | 'ai';
  /** transparent PNG logo (media id): shown as the title reveal and on the end card */
  logoMediaId?: string;
  /** island thumbnail (media id): background of the end card */
  thumbnailMediaId?: string;
  /** seconds into the song where the trailer's music starts (skip an intro) */
  musicStart?: number;
}

// ---------------------------------------------------------------------------- style parsing

const has = (t: string, words: string[]) => words.some((w) => new RegExp(`\\b${w}`, 'i').test(t));

export function parseStyle(text: string, defaults: { mode: TrailerMode; duration: number; aspect: AspectId }): TrailerStyle {
  const t = text.trim();
  let mode = defaults.mode;
  if (has(t, ['no ui', 'no hud', 'without ui', 'without hud', 'cinematic trailer'])) mode = 'cinematic';
  if (has(t, ['gameplay trailer', 'with ui', 'with hud', 'show the ui', 'show the hud'])) mode = 'gameplay';
  let aspect = defaults.aspect;
  if (has(t, ['vertical', '9:16', 'tiktok', 'shorts', 'reels', 'portrait'])) aspect = '9:16';
  else if (has(t, ['square', '1:1'])) aspect = '1:1';
  let duration = defaults.duration;
  const sec = /(\d{1,3})\s*(s|sec|secs|second|seconds)\b/i.exec(t);
  const min = /(\d(?:\.\d)?)\s*(m|min|mins|minute|minutes)\b/i.exec(t);
  if (sec) duration = Number(sec[1]);
  else if (min) duration = Number(min[1]) * 60;
  else if (aspect === '9:16' && aspect !== defaults.aspect) duration = Math.min(defaults.duration, 15);
  duration = clamp(duration, 8, 180);
  let mood: Mood = mode === 'cinematic' ? 'epic' : 'hype';
  if (has(t, ['horror', 'scary', 'creepy', 'spooky', 'terror', 'nightmare', 'haunted', 'clown', 'dread'])) mood = 'horror';
  else if (has(t, ['mystery', 'mysterious', 'secret', 'suspense', 'tension', 'unknown'])) mood = 'mystery';
  else if (has(t, ['funny', 'fun ', 'silly', 'colorful', 'colourful', 'happy', 'party', 'goofy', 'cute'])) mood = 'fun';
  else if (has(t, ['chill', 'calm', 'relax', 'cozy', 'peaceful'])) mood = 'chill';
  else if (has(t, ['epic', 'dramatic', 'emotional', 'story', 'cinematic', 'legendary'])) mood = 'epic';
  else if (has(t, ['hype', 'intense', 'action', 'energetic', 'insane', 'crazy', 'fast', 'adrenaline'])) mood = 'hype';
  let pacing: Pacing = mood === 'hype' || mood === 'fun' ? 'fast' : mood === 'chill' ? 'slow' : 'medium';
  if (has(t, ['slow', 'atmospheric', 'slow build', 'moody'])) pacing = 'slow';
  if (has(t, ['fast cuts', 'quick cuts', 'rapid', 'fast-paced', 'fast paced'])) pacing = 'fast';
  // "double" or “curly” quotes anywhere; 'single' quotes only as real quote marks (not apostrophes in don't / island's)
  const quoted = [...t.matchAll(/["“]([^"”]{2,60})["”]|(?:^|[\s(:,])'([^'\n]{2,60})'(?=$|[\s),.!?:;])/g)].map((m) => (m[1] ?? m[2]).trim());
  // "title is X", "title: X", "called X", "named X" (but not "a big title reveal")
  const named = /(?:\btitle\s*(?:is|:)|\bcalled|\bnamed|\bisland name\s*(?:is|:)?)\s*([A-Z0-9][\w' !?-]{1,40})/i.exec(t);
  const title = (quoted[0] ?? named?.[1] ?? '').trim();
  const tagMatch = /tagline\s*(?:is|:)?\s*["“]?([^"”\n.]{3,80})/i.exec(t);
  const tagline = (tagMatch?.[1] ?? quoted[1] ?? '').trim();
  const code = /\b(\d{4}-\d{4}-\d{4})\b/.exec(t)?.[1] ?? '';
  const featMatch = /features?\s*(?:are|:)?\s*([^.\n]+)/i.exec(t);
  const features = featMatch
    ? featMatch[1]
        .split(/,| and /i)
        .map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 40)
        .slice(0, 4)
    : [];
  const look: LookId = mood === 'horror' ? 'horror' : mood === 'fun' || mood === 'hype' ? 'vibrant' : mood === 'chill' ? 'vibrant' : 'cinematic';
  const letterbox = mode === 'cinematic' || has(t, ['letterbox', 'widescreen', '2.39', 'scope']);
  const slowMo = mode === 'cinematic' || has(t, ['slow-mo', 'slow mo', 'slowmo', 'slow motion']);
  const endCard = has(t, ['coming soon', 'soon']) ? (code ? 'both' : 'comingSoon') : 'playNow';
  return {
    mode,
    duration,
    aspect,
    mood,
    pacing,
    title,
    tagline,
    islandCode: code,
    features,
    look,
    letterbox: aspect === '9:16' ? false : letterbox,
    slowMo,
    beatSync: !has(t, ['no beat', 'not on the beat']),
    endCard,
  };
}

// ---------------------------------------------------------------------------- sections

function sec(name: string, duration: number, shotLength: number, energy: number, transition: TransitionType | null, extra: Partial<ConceptSection> = {}): ConceptSection {
  return { id: uid('sec_'), name, duration, shotLength, energy, transition, speed: 1, ...extra };
}

/** Transitions that suit each mood: [section changes, quick in-section accents]. */
export const MOOD_TRANSITIONS: Record<Mood, { section: TransitionType[]; accent: TransitionType[] }> = {
  hype: { section: ['whipPan', 'zoomBlur', 'flash', 'pushLeft', 'spin'], accent: ['zoomPunch', 'whipRight', 'rgbSplit', 'shakeCut', 'flash'] },
  horror: { section: ['dipBlack', 'glitch', 'filmBurn', 'blurDissolve'], accent: ['glitch', 'rgbSplit', 'shakeCut', 'flash'] },
  epic: { section: ['dipBlack', 'lightLeak', 'zoomBlur', 'crossfade', 'iris'], accent: ['zoomPunch', 'flash', 'whipPan'] },
  fun: { section: ['slideLeft', 'iris', 'spin', 'pushUp', 'diamond', 'clockWipe'], accent: ['zoomPunch', 'whipRight', 'slideUp', 'flash'] },
  mystery: { section: ['blurDissolve', 'dipBlack', 'wipeDiagonal', 'glitch'], accent: ['glitch', 'rgbSplit', 'flash'] },
  chill: { section: ['crossfade', 'lightLeak', 'wipeRight', 'blurDissolve', 'blinds'], accent: ['crossfade', 'slideLeft'] },
};

export function planSections(s: TrailerStyle): ConceptSection[] {
  const pal = MOOD_TRANSITIONS[s.mood] ?? MOOD_TRANSITIONS.hype;
  const pick = (i: number) => pal.section[i % pal.section.length];
  const D = s.duration;
  const endDur = D <= 16 ? 3 : D <= 35 ? 4.5 : 6;
  const body = D - endDur;
  const pace = { slow: 1.35, medium: 1, fast: 0.7 }[s.pacing];
  const title = s.title || 'YOUR ISLAND';
  const out: ConceptSection[] = [];
  if (D <= 16) {
    out.push(sec('Hook', Math.min(2.2, body * 0.18), 1.1, 1, null, { text: { text: s.tagline || 'WAIT FOR IT…', preset: 'scalePunch' } }));
    out.push(sec('Action', body - out[0].duration, 0.9 * pace, 0.95, 'flash'));
  } else if (s.mode === 'gameplay') {
    out.push(sec('Hook', clamp(body * 0.12, 2, 4), 1.2 * pace, 1, null, { text: { text: s.tagline || title, preset: 'slam' } }));
    const feats = s.features.length ? s.features : ['FEATURE ONE', 'FEATURE TWO', 'FEATURE THREE'];
    const featDur = body * 0.4;
    feats.forEach((f, i) =>
      out.push(sec(`Feature ${i + 1}`, featDur / feats.length, 2 * pace, 0.55, pick(i), { text: { text: f.toUpperCase(), sub: 'Feature callout — edit me', preset: 'lowerThird' } })),
    );
    out.push(sec('Action montage', body - out.reduce((a, x) => a + x.duration, 0), 0.85 * pace, 1, pick(feats.length)));
  } else {
    const slowSpeed = s.slowMo ? 0.7 : 1;
    out.push(sec('Slow build', body * 0.3, 3.2 * pace, 0.2, 'dipBlack', { speed: slowSpeed, text: { text: s.tagline || (s.mood === 'horror' ? 'SOMETHING IS WATCHING' : 'A NEW WORLD AWAITS'), preset: 'fadeUp' } }));
    out.push(sec('Reveal', body * 0.18, 2 * pace, 0.55, pick(1), { speed: s.slowMo ? 0.85 : 1 }));
    out.push(sec('Beat-synced action', body * 0.37, 0.9 * pace, 1, pick(2)));
    out.push(sec('Title', body - out.reduce((a, x) => a + x.duration, 0), 2.5, 0.3, 'dipBlack', { speed: slowSpeed, text: { text: title.toUpperCase(), preset: 'slam' } }));
  }
  out.push(
    sec('End card', endDur, endDur, 0.1, 'dipBlack', {
      endCard: true,
      text: { text: s.endCard === 'comingSoon' ? 'COMING SOON' : 'PLAY NOW', sub: s.islandCode, preset: s.endCard === 'comingSoon' ? 'comingSoon' : 'playNow' },
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------- candidates

export interface AnalyzedMedia {
  media: MediaItem;
  analysis: FootageAnalysis;
}

const avg = (a: number[], i: number, n: number) => {
  let s = 0;
  let c = 0;
  for (let k = i; k < i + n && k < a.length; k++) {
    s += a[k];
    c++;
  }
  return c ? s / c : 0;
};
const mx = (a: number[], i: number, n: number) => {
  let m = 0;
  for (let k = i; k < i + n && k < a.length; k++) m = Math.max(m, a[k]);
  return m;
};

/** Score every 2-second window of every clip. */
export function buildCandidates(items: AnalyzedMedia[], mode: TrailerMode, windowSec = 2): ShotCandidate[] {
  const out: ShotCandidate[] = [];
  for (const { media, analysis: a } of items) {
    const n = a.motion.length;
    const hudRemovable = hudReframe(a.hudBoxes).scale <= 1.45;
    for (let i = 0; i + 1 <= n; i += 1) {
      const len = Math.min(windowSec, media.duration - i);
      if (len < 0.8) continue;
      const w = Math.max(1, Math.round(len));
      const motion = avg(a.motion, i, w);
      const loud = avg(a.loudness, i, w);
      const peaks = mx(a.peaks, i, w);
      const gun = mx(a.gunfire, i, w);
      const hud = avg(a.hud, i, w);
      const bright = avg(a.brightness, i, w);
      const detail = avg(a.detail, i, w);
      const cutInside = a.sceneCut.slice(i + 1, i + w).some((c) => c > 0);
      const dark = bright < 0.1;
      const flat = detail < 0.1;
      const flags: string[] = [];
      let quality = 0;
      if (dark) {
        quality -= 0.7;
        flags.push('too dark');
      }
      if (flat) {
        quality -= 0.6;
        flags.push('flat / menu / loading');
      }
      if (cutInside) quality -= 0.3;
      if (motion < 0.02) {
        quality -= 0.3;
        flags.push('frozen');
      }
      if (gun > 0.35) {
        quality -= 1.5 * gun;
        flags.push('possible gunfire');
      }
      if (mode === 'cinematic' && hud > 0.4) {
        if (hudRemovable) flags.push('HUD (auto-removed)');
        else {
          quality -= 0.8;
          flags.push('HUD hard to remove');
        }
      }
      const action = clamp(0.5 * Math.min(1, motion * 1.6) + 0.25 * loud + 0.25 * peaks, 0, 1);
      // calm, cinematic shots: gentle movement, good exposure, detail
      const calm = clamp(1 - Math.abs(motion - 0.18) * 3, 0, 1) * 0.7 + Math.min(1, detail) * 0.3;
      out.push({
        id: `${media.id}@${i}`,
        mediaId: media.id,
        mediaName: media.name,
        srcIn: i,
        length: len,
        motion,
        loudness: loud,
        peaks,
        hud,
        gunfire: gun,
        dark,
        flat,
        action,
        calm,
        quality,
        flags,
      });
    }
  }
  return out;
}

function overlaps(a: { mediaId: string; srcIn: number; length: number }, b: { mediaId: string; srcIn: number; length: number }, pad = 0.5): boolean {
  return a.mediaId === b.mediaId && a.srcIn < b.srcIn + b.length + pad && b.srcIn < a.srcIn + a.length + pad;
}

/** Pick shots for every section (greedy, varied sources; footage is only reused when it runs out). */
export function pickShots(sections: ConceptSection[], cands: ShotCandidate[]): ConceptShot[] {
  const used: { mediaId: string; srcIn: number; length: number }[] = [];
  const useCount = new Map<string, number>();
  const shots: ConceptShot[] = [];
  let lastMedia = '';
  let lastId = '';
  for (const s of sections) {
    const count = Math.max(1, Math.round(s.duration / s.shotLength));
    const shotLen = s.duration / count;
    for (let k = 0; k < count; k++) {
      const need = shotLen * s.speed;
      const score = (c: ShotCandidate) => {
        let v = s.energy * c.action + (1 - s.energy) * c.calm + c.quality;
        if (s.endCard) v = c.calm * 0.6 + c.quality + (1 - c.motion) * 0.4;
        if (c.mediaId === lastMedia) v -= 0.15;
        return v;
      };
      const ok = (c: ShotCandidate) => c.gunfire <= 0.35 && c.length + 0.01 >= Math.min(need, 1.5);
      let best: ShotCandidate | null = null;
      let bestScore = -Infinity;
      // pass 1: fresh footage only
      for (const c of cands) {
        if (!ok(c)) continue;
        if (used.some((u) => overlaps(u, { mediaId: c.mediaId, srcIn: c.srcIn, length: Math.max(need, 1) }))) continue;
        const v = score(c);
        if (v > bestScore) {
          bestScore = v;
          best = c;
        }
      }
      // pass 2: not enough footage — reuse the least-used good shots
      if (!best) {
        for (const c of cands) {
          if (!ok(c) || c.id === lastId) continue;
          const v = score(c) - 0.4 * (useCount.get(c.id) ?? 0);
          if (v > bestScore) {
            bestScore = v;
            best = c;
          }
        }
      }
      if (!best) break;
      used.push({ mediaId: best.mediaId, srcIn: best.srcIn, length: Math.max(need, 1) });
      useCount.set(best.id, (useCount.get(best.id) ?? 0) + 1);
      lastMedia = best.mediaId;
      lastId = best.id;
      shots.push({ candidateId: best.id, sectionId: s.id, include: true, length: shotLen });
    }
  }
  return shots;
}

export function buildConcept(style: TrailerStyle, items: AnalyzedMedia[], musicMediaId?: string): TrailerConcept {
  const sections = planSections(style);
  const candidates = buildCandidates(items, style.mode);
  const shots = pickShots(sections, candidates);
  const notes: string[] = [];
  const used = new Set(shots.map((s) => s.candidateId));
  const flagged = candidates.filter((c) => used.has(c.id) && c.flags.length);
  if (!items.length) notes.push('No video clips were analyzed — import gameplay footage first.');
  if (flagged.some((c) => c.flags.includes('possible gunfire'))) notes.push('Some picked shots may still contain gunfire — check the flagged shots.');
  const gunTotal = candidates.filter((c) => c.gunfire > 0.35).length;
  if (gunTotal) notes.push(`${gunTotal} moments with likely gunfire were skipped (not allowed in UEFN trailers).`);
  if (style.mode === 'cinematic') {
    const hudMedia = items.filter((i) => i.analysis.hudScore > 0.05);
    if (hudMedia.length)
      notes.push(
        `HUD found in ${hudMedia.length} clip(s): it is removed by reframing (zoom/crop) plus a fill for small leftovers. For Epic's review, cinematic shots recorded with the HUD off are safest.`,
      );
  }
  const title = style.title || 'Your Island';
  const logline =
    style.mode === 'cinematic'
      ? `${moodWord(style.mood)} cinematic trailer: ${sections.map((s) => s.name.toLowerCase()).join(' → ')}.`
      : `${moodWord(style.mood)} gameplay trailer: ${sections.map((s) => s.name.toLowerCase()).join(' → ')}.`;
  return { version: 1, title, logline, style, musicMediaId, sections, shots, candidates, notes, source: 'local' };
}

function moodWord(m: Mood): string {
  return { hype: 'High-energy', horror: 'Creepy, slow-burn', epic: 'Epic', fun: 'Colorful, fun', mystery: 'Mysterious', chill: 'Laid-back' }[m];
}

// ---------------------------------------------------------------------------- HUD removal

/** Find the smallest zoom (and center) whose frame window avoids all HUD boxes (crosshair excluded). */
export function hudReframe(boxes: HudBox[], maxScale = 1.6): { scale: number; cx: number; cy: number; leftover: HudBox[] } {
  const pad = 0.025;
  const relevant = boxes
    .filter((b) => !(b.w * b.h < 0.03 && Math.abs(b.x + b.w / 2 - 0.5) < 0.12 && Math.abs(b.y + b.h / 2 - 0.5) < 0.12))
    .map((b) => ({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }));
  const crosshair = boxes.filter((b) => !relevant.some((r) => Math.abs(r.x + pad - b.x) < 1e-6 && Math.abs(r.y + pad - b.y) < 1e-6));
  if (!relevant.length) return { scale: 1, cx: 0.5, cy: 0.5, leftover: crosshair };
  for (let s = 1; s <= maxScale + 1e-6; s += 0.02) {
    const half = 0.5 / s;
    let best: { cx: number; cy: number; d: number } | null = null;
    for (let cx = half; cx <= 1 - half + 1e-6; cx += 0.01)
      for (let cy = half; cy <= 1 - half + 1e-6; cy += 0.01) {
        const L = cx - half, R = cx + half, T = cy - half, B = cy + half;
        const hit = relevant.some((b) => b.x < R && b.x + b.w > L && b.y < B && b.y + b.h > T);
        if (hit) continue;
        const d = Math.hypot(cx - 0.5, cy - 0.5);
        if (!best || d < best.d) best = { cx, cy, d };
      }
    if (best) return { scale: +s.toFixed(2), cx: best.cx, cy: best.cy, leftover: crosshair };
  }
  // Could not crop everything away: use the max zoom centered and fill what is left.
  const half = 0.5 / maxScale;
  const L = 0.5 - half, R = 0.5 + half, T = 0.5 - half, B = 0.5 + half;
  const left = relevant.filter((b) => b.x < R && b.x + b.w > L && b.y < B && b.y + b.h > T);
  return { scale: maxScale, cx: 0.5, cy: 0.5, leftover: [...crosshair, ...left] };
}

// ---------------------------------------------------------------------------- timeline build

/** Built-in sound effects available to the trailer builder (media ids already in the project). */
export type SfxKind = 'whoosh' | 'whoosh-fast' | 'reverse-whoosh' | 'riser' | 'boom' | 'hit' | 'braam' | 'glitch';

export interface BuildOptions {
  /** add whooshes / hits / risers / booms automatically */
  sfx?: Partial<Record<SfxKind, string>>;
  fps: number;
  /** beat times in seconds of the music file */
  beats?: number[];
  analyses: Record<string, FootageAnalysis>;
}

export function buildTrailerProject(base: Project, concept: TrailerConcept, opts: BuildOptions): Project {
  const st = concept.style;
  const p = createProject(concept.title, st.aspect, opts.fps);
  p.media = structuredClone(base.media);
  p.fonts = structuredClone(base.fonts);
  p.settings.normalizeLoudness = true;
  const f = opts.fps;
  const W = ASPECTS[st.aspect].width;
  const H = ASPECTS[st.aspect].height;
  const v1 = tracksOfKind(p, 'video').slice(-1)[0];
  const v2 = tracksOfKind(p, 'video').slice(-2)[0];
  const textTrack = tracksOfKind(p, 'text')[0];
  const music = tracksOfKind(p, 'audio').find((t) => t.role === 'music')!;
  const game = tracksOfKind(p, 'audio').find((t) => t.role === 'game')!;
  const candById = new Map(concept.candidates.map((c) => [c.id, c]));
  const musicStart = Math.max(0, concept.musicStart ?? 0);
  // beats are in song time; the song starts musicStart seconds in
  const beats = (opts.beats ?? []).map((b) => b - musicStart).filter((b) => b > 0.05);
  const snapToBeat = (t: number, maxShift: number) => {
    if (!st.beatSync || !beats.length) return t;
    let best = t;
    let bd = maxShift;
    for (const b of beats) {
      const d = Math.abs(b - t);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  };
  const logo = concept.logoMediaId ? p.media[concept.logoMediaId] : undefined;
  const thumb = concept.thumbnailMediaId ? p.media[concept.thumbnailMediaId] : undefined;
  const logoTrack = tracksOfKind(p, 'video').slice(-3)[0] ?? addTrack(p, 'video');
  const titleText = (st.title || concept.title || '').trim().toUpperCase();
  /** A logo image: fitted into maxW × maxH (fractions of the frame), centred at cyFrac, scale-in + fades. */
  const addLogo = (start: number, dur: number, maxW: number, maxH: number, cyFrac: number) => {
    if (!logo || logo.width <= 0 || logo.height <= 0) return;
    const lc = clipFromMedia(logo, logoTrack.id, snapFrame(start, f), f);
    lc.duration = snapFrame(Math.max(0.5, dur), f);
    lc.fit = 'fit';
    const baseW = logo.width * Math.min(W / logo.width, H / logo.height);
    const wantW = Math.min(maxW * W, maxH * H * (logo.width / logo.height));
    const us = wantW / Math.max(1, baseW);
    lc.transform.scale = {
      value: us,
      keys: [
        { t: 0, v: us * 0.82, ease: 'easeOut' },
        { t: Math.min(0.55, lc.duration / 2), v: us, ease: 'linear' },
        { t: lc.duration, v: us * 1.04, ease: 'linear' },
      ],
    };
    lc.transform.y = { value: Math.round((cyFrac - 0.5) * H) };
    lc.videoFadeIn = Math.min(0.35, lc.duration / 3);
    lc.videoFadeOut = Math.min(0.3, lc.duration / 3);
    lc.fadeColor = 'transparent';
    placeClip(p, lc);
  };
  const reveals: number[] = [];
  let endCardAt = -1;
  let t = 0;
  for (const s of concept.sections) {
    const secStart = t;
    addMarker(p, snapFrame(secStart, f), 'section', s.name, s.endCard ? '#3ccf8e' : '#7c5cff');
    // with a thumbnail the end card shows it instead of gameplay shots
    const shots = s.endCard && thumb ? [] : concept.shots.filter((x) => x.sectionId === s.id && x.include);
    const secEndTarget = secStart + s.duration;
    shots.forEach((shot, i) => {
      const c = candById.get(shot.candidateId);
      if (!c) return;
      const m = p.media[c.mediaId];
      if (!m) return;
      let end = i === shots.length - 1 ? secEndTarget : t + shot.length;
      end = snapToBeat(end, Math.min(0.3, shot.length * 0.35));
      end = snapFrame(Math.max(t + 0.4, end), f);
      const len = end - t;
      const clip = clipFromMedia(m, v1.id, snapFrame(t, f), f);
      clip.duration = len;
      clip.speed = s.speed;
      const needSrc = len * s.speed;
      clip.in = clamp(c.srcIn + Math.max(0, (c.length - needSrc) / 2), 0, Math.max(0, m.duration - needSrc - 0.05));
      clip.audioDetached = false;
      clip.volume = st.mode === 'cinematic' ? 0.15 : 0.45; // music carries the trailer; game audio low
      // look
      clip.color = { ...clip.color, look: st.look, lookIntensity: st.mood === 'chill' ? 0.5 : 0.8, vignette: st.mode === 'cinematic' ? 0.35 : 0.15 };
      if (s.endCard) clip.color = { ...clip.color, brightness: -0.45, saturation: -0.3, vignette: 0.6 };
      // HUD removal (cinematic, or any shot that shows the HUD in cinematic mode)
      const an = opts.analyses[c.mediaId];
      if (st.mode === 'cinematic' && an && (c.hud > 0.3 || an.hudScore > 0.05)) {
        const r = hudReframe(an.hudBoxes);
        if (r.scale > 1.001 || r.cx !== 0.5 || r.cy !== 0.5) {
          clip.fit = 'fill';
          clip.transform.scale = { value: r.scale };
          clip.transform.x = { value: Math.round((0.5 - r.cx) * W * r.scale) };
          clip.transform.y = { value: Math.round((0.5 - r.cy) * H * r.scale) };
        }
        if (r.leftover.length) clip.cleanup = r.leftover.slice(0, 4);
      }
      // aspect: keep the action centered when going vertical
      if (st.aspect !== '16:9') clip.reframe = { enabled: true, focusX: { value: 0.5 }, focusY: { value: 0.5 } };
      // transitions: section boundary uses the section transition, inside slow sections a soft crossfade
      if (i === 0 && s.transition && secStart > 0) clip.transitionIn = { type: s.transition, duration: Math.min(defaultTransitionDuration(s.transition), len / 2) };
      else if (i > 0 && s.energy < 0.4) clip.transitionIn = { type: 'crossfade', duration: Math.min(0.8, len / 3) };
      else if (i > 0 && s.energy >= 0.85 && i % 3 === 2) {
        // quick accent transitions keep fast montages lively (most cuts stay hard cuts)
        const acc = (MOOD_TRANSITIONS[st.mood] ?? MOOD_TRANSITIONS.hype).accent;
        const type = acc[Math.floor(i / 3) % acc.length];
        clip.transitionIn = { type, duration: Math.min(defaultTransitionDuration(type), 0.35, len / 2) };
      }
      // energy: punch-ins and shake on loud hits in action sections
      if (s.energy >= 0.9 && st.mode === 'gameplay' && i % 3 === 1) {
        const at = Math.min(len - 0.3, 0.05);
        const base = clip.transform.scale.value;
        clip.transform.scale = {
          value: base,
          keys: [
            { t: 0, v: base, ease: 'easeOut' },
            { t: at + 0.12, v: base * 1.18, ease: 'easeInOut' },
            { t: Math.min(len, at + 0.6), v: base * 1.08, ease: 'linear' },
          ],
        };
      }
      if (s.endCard) {
        // end screen: blurry, darker background behind the logo / PLAY NOW / code
        clip.blur = 16;
        clip.color = { ...clip.color, brightness: Math.min(clip.color.brightness, -0.3), vignette: Math.max(clip.color.vignette, 0.45) };
        clip.transform.opacity = { value: 0.6 };
        const sc = clip.transform.scale.value;
        clip.transform.scale = { value: sc * 1.1, keys: [{ t: 0, v: sc * 1.1, ease: 'linear' }, { t: len, v: sc * 1.16, ease: 'linear' }] };
        clip.shakes = [];
        clip.speed = Math.min(clip.speed, 0.7);
      }
      if (!s.endCard && s.energy >= 0.9 && c.peaks > 0.5) clip.shakes = [{ at: 0, duration: Math.min(0.45, len), intensity: 0.45, frequency: 10 }];
      placeClip(p, clip);
      t = end;
    });
    // a section without shots still takes its time (black); otherwise continue seamlessly from the last cut
    if (!shots.length) t = snapFrame(secEndTarget, f);
    if (s.endCard && thumb && thumb.width > 0) {
      // island thumbnail as the end-card background: darkened, slow push-in
      const tc0 = clipFromMedia(thumb, v1.id, snapFrame(secStart, f), f);
      tc0.duration = snapFrame(t - secStart, f);
      tc0.fit = 'fill';
      // blurry, darkened background so the logo and PLAY NOW pop (scaled up so blurred edges stay off-screen)
      tc0.color = { ...tc0.color, brightness: -0.3, saturation: 0.1, vignette: 0.45 };
      tc0.blur = 16;
      tc0.transform.opacity = { value: 0.6 }; // over black: a clearly dimmed background
      tc0.transform.scale = { value: 1.1, keys: [{ t: 0, v: 1.1, ease: 'linear' }, { t: tc0.duration, v: 1.17, ease: 'linear' }] };
      tc0.videoFadeIn = Math.min(0.4, tc0.duration / 4);
      tc0.videoFadeOut = Math.min(0.6, tc0.duration / 4);
      tc0.fadeColor = 'black';
      if (s.transition) tc0.transitionIn = { type: s.transition, duration: Math.min(defaultTransitionDuration(s.transition), tc0.duration / 2) };
      placeClip(p, tc0);
    }
    const vertical = st.aspect === '9:16';
    if (s.endCard && logo) addLogo(secStart + 0.2, t - secStart - 0.2, vertical ? 0.78 : 0.42, vertical ? 0.24 : 0.3, vertical ? 0.28 : 0.27);
    // title reveal: the logo replaces the title text
    const isTitle = !s.endCard && !!s.text?.text && !!titleText && s.text.text.trim().toUpperCase() === titleText;
    if (isTitle) reveals.push(secStart + Math.min(0.3, s.duration * 0.1));
    if (s.endCard) endCardAt = secStart;
    if (isTitle && logo) {
      addLogo(secStart + Math.min(0.3, s.duration * 0.1), Math.min(s.duration - 0.3, 3.5), vertical ? 0.86 : 0.6, vertical ? 0.36 : 0.46, 0.5);
    }
    // text
    if (s.text && s.text.text && !(isTitle && logo)) {
      const isEnd = !!s.endCard;
      const startT = secStart + (isEnd ? 0.3 : Math.min(0.4, s.duration * 0.1));
      const dur = Math.max(1, (isEnd ? s.duration - 0.3 : Math.min(s.duration - 0.4, 3)));
      const tc = makeClip('text', textTrack.id, snapFrame(startT, f), snapFrame(dur, f), { name: s.text.text, fit: 'fit', text: defaultText(s.text.text) });
      applyTextPreset(tc, s.text.preset, st, s.text.text, isEnd ? '' : s.text.sub);
      if (isEnd && logo) {
        tc.text!.posY = vertical ? 0.55 : 0.6;
        tc.text!.fontSize = Math.round(tc.text!.fontSize * 0.8);
      }
      placeClip(p, tc);
      if (isEnd && st.islandCode) {
        const t2 = tracksOfKind(p, 'text')[1] ?? addTrack(p, 'text');
        const cc = makeClip('text', t2.id, snapFrame(startT + 0.3, f), snapFrame(dur - 0.3, f), { name: st.islandCode, fit: 'fit', text: defaultText(st.islandCode) });
        applyTextPreset(cc, 'islandCode', st, st.islandCode);
        if (logo) cc.text!.posY = vertical ? 0.68 : 0.8;
        placeClip(p, cc);
      }
      if (isEnd && st.endCard === 'both') {
        // COMING SOON first, then PLAY NOW
        const half = snapFrame(dur / 2, f);
        tc.duration = half;
        applyTextPreset(tc, 'comingSoon', st, 'COMING SOON');
        tc.text!.animOut = 'fadeUp';
        tc.text!.animOutDuration = 0.3;
        if (logo) {
          tc.text!.posY = vertical ? 0.55 : 0.6;
          tc.text!.fontSize = Math.round(tc.text!.fontSize * 0.8);
        }
        const pn = makeClip('text', textTrack.id, snapFrame(startT + half, f), snapFrame(dur - half, f), { name: 'PLAY NOW', fit: 'fit', text: defaultText('PLAY NOW') });
        applyTextPreset(pn, 'playNow', st, 'PLAY NOW');
        if (logo) {
          pn.text!.posY = vertical ? 0.55 : 0.6;
          pn.text!.fontSize = Math.round(pn.text!.fontSize * 0.8);
        }
        placeClip(p, pn);
      }
    }
  }
  const total = snapFrame(t, f);
  // letterbox for cinematic sections (not over the end card)
  if (st.letterbox) {
    const endSec = concept.sections.find((s) => s.endCard);
    const endStart = endSec ? total - endSec.duration : total;
    const lb = makeClip('adjust', v2.id, 0, snapFrame(endStart, f), { name: 'Letterbox 2.39:1', adjust: defaultAdjust() });
    placeClip(p, lb);
  }
  // music
  const mm = concept.musicMediaId ? p.media[concept.musicMediaId] : undefined;
  if (mm) {
    const mc = clipFromMedia(mm, music.id, 0, f);
    const start = Math.min(musicStart, Math.max(0, mm.duration - 1));
    mc.in = start;
    mc.duration = Math.min(total, mm.duration - start);
    mc.fadeIn = st.mode === 'cinematic' ? 1 : 0.1;
    mc.fadeOut = Math.min(2.5, mc.duration / 3);
    mc.volume = 0.9;
    placeClip(p, mc);
  }
  if (opts.sfx) addTrailerSfx(p, opts.sfx, st, reveals, endCardAt, total, f);
  void game;
  p.inPoint = 0;
  p.outPoint = total;
  return p;
}

const SFX_LEN: Record<SfxKind, number> = { whoosh: 1.0, 'whoosh-fast': 0.45, 'reverse-whoosh': 1.2, riser: 3, boom: 2.5, hit: 0.7, braam: 3.5, glitch: 0.6 };
/** Where the loudest moment of each sound is (seconds from its start), to line it up with a cut. */
const SFX_PEAK: Record<SfxKind, number> = { whoosh: 0.5, 'whoosh-fast': 0.22, 'reverse-whoosh': 1.17, riser: 2.95, boom: 0.02, hit: 0.01, braam: 0.08, glitch: 0.05 };

function sfxForTransition(type: TransitionType, dur: number): SfxKind | null {
  if (/^(crossfade|blurDissolve|lightLeak|dipBlack|dipWhite)$/.test(type)) return null; // soft transitions stay quiet
  if (type === 'glitch' || type === 'rgbSplit') return 'glitch';
  if (type === 'zoomPunch' || type === 'shakeCut' || type === 'flash' || type === 'filmBurn') return 'hit';
  return dur <= 0.45 ? 'whoosh-fast' : 'whoosh';
}

/** Place sound effects: whooshes/hits on transitions, a riser + boom on the title reveal, a boom on the end card. */
function addTrailerSfx(p: Project, ids: Partial<Record<SfxKind, string>>, st: TrailerStyle, reveals: number[], endCardAt: number, total: number, f: number): void {
  const place = (kind: SfxKind, peakAt: number, volume: number) => {
    const mid = ids[kind];
    const m = mid ? p.media[mid] : undefined;
    if (!m) return;
    const len = Math.min(SFX_LEN[kind], m.duration || SFX_LEN[kind]);
    let start = peakAt - SFX_PEAK[kind];
    let inPt = 0;
    if (start < 0) {
      inPt = -start;
      start = 0;
    }
    const dur = Math.min(len - inPt, total - start);
    if (dur < 0.1) return;
    const a = snapFrame(start, f);
    const b = a + snapFrame(dur, f);
    // a free effects track (adds one when all are busy); never the game or music track
    let tr = tracksOfKind(p, 'audio').find((x) => (x.role === 'sfx' || x.role === 'voice') && !x.locked && isRangeFree(p, x.id, a, b));
    if (!tr) {
      tr = addTrack(p, 'audio');
      tr.role = 'sfx';
      tr.name = `A${tracksOfKind(p, 'audio').length} SFX`;
    }
    const c = clipFromMedia(m, tr.id, a, f);
    c.in = inPt;
    c.duration = snapFrame(dur, f);
    c.volume = volume;
    c.fadeOut = Math.min(0.15, c.duration / 3);
    placeClip(p, c);
  };
  const usedAt = new Set<number>();
  for (const c of Object.values(p.clips)) {
    if (c.kind !== 'video' && c.kind !== 'image') continue;
    if (!c.transitionIn || c.start < 0.05) continue;
    const kind = sfxForTransition(c.transitionIn.type, c.transitionIn.duration);
    if (!kind) continue;
    const key = Math.round(c.start * 10);
    if (usedAt.has(key)) continue;
    usedAt.add(key);
    place(kind, c.start, kind === 'hit' ? 0.55 : 0.45);
  }
  const heavy: SfxKind = st.mood === 'horror' || st.mood === 'epic' || st.mood === 'mystery' ? 'braam' : 'boom';
  for (const r of reveals) {
    if (r >= 2.5) place('riser', r, 0.5);
    place(heavy, r, 0.8);
  }
  if (endCardAt > 0) place('boom', endCardAt, 0.6);
}

/** Bundled display fonts that fit each mood (fall back to system fonts if a font is missing). */
export function moodFonts(m: Mood): { title: string; body: string; code: string } {
  switch (m) {
    case 'horror':
      return { title: 'Creepster', body: 'Special Elite', code: 'Chakra Petch' };
    case 'mystery':
      return { title: 'Cinzel', body: 'Cinzel', code: 'Chakra Petch' };
    case 'epic':
      return { title: 'Bebas Neue', body: 'Cinzel', code: 'Russo One' };
    case 'fun':
      return { title: 'Luckiest Guy', body: 'Lilita One', code: 'Lilita One' };
    case 'chill':
      return { title: 'Fredoka', body: 'Fredoka', code: 'Fredoka' };
    default:
      return { title: 'Luckiest Guy', body: 'Bebas Neue', code: 'Russo One' };
  }
}

function applyTextPreset(c: Clip, preset: string, st: TrailerStyle, text: string, sub?: string): void {
  const vertical = st.aspect === '9:16';
  const t = c.text!;
  const mf = moodFonts(st.mood);
  t.text = text;
  t.uppercase = true;
  const anim = (a: TextAnimation, d: number) => {
    t.animIn = a;
    t.animInDuration = d;
  };
  switch (preset) {
    case 'slam':
      Object.assign(t, { fontFamily: mf.title, fontWeight: 400, fontSize: vertical ? 130 : 180, letterSpacing: 4, shadowBlur: 30, shadowOffset: 8, animOut: 'fadeUp', animOutDuration: 0.3 });
      anim('slam', 0.55);
      break;
    case 'scalePunch':
      Object.assign(t, { fontFamily: mf.title, fontWeight: 400, fontSize: vertical ? 110 : 140, posY: vertical ? 0.3 : 0.5, animOut: 'scalePunch', animOutDuration: 0.25 });
      anim('scalePunch', 0.35);
      break;
    case 'fadeUp':
      Object.assign(t, { fontFamily: mf.body, fontWeight: 700, fontSize: vertical ? 70 : 84, letterSpacing: 14, shadowBlur: 20, animOut: 'fadeUp', animOutDuration: 0.6 });
      anim(st.mood === 'horror' || st.mood === 'mystery' ? 'glitchIn' : 'fadeUp', 0.8);
      break;
    case 'lowerThird':
      Object.assign(t, {
        subText: sub || 'Feature callout — edit me',
        subSize: 34,
        subColor: '#c9d3ff',
        fontFamily: mf.body,
        fontWeight: 400,
        fontSize: 64,
        box: true,
        boxColor: 'rgba(12,14,30,0.82)',
        boxPadding: 26,
        boxRadius: 6,
        accentBar: true,
        accentColor: '#ffd23f',
        posX: vertical ? 0.08 : 0.07,
        posY: vertical ? 0.7 : 0.8,
        align: 'left',
        shadowBlur: 0,
        shadowOffset: 0,
        animOut: 'fadeUp',
        animOutDuration: 0.3,
      });
      anim('fadeUp', 0.4);
      break;
    case 'playNow':
      Object.assign(t, { fontFamily: mf.title, fontWeight: 400, fontSize: vertical ? 140 : 170, color: '#ffd23f', outlineColor: '#1a1030', outlineWidth: 6, letterSpacing: 6, posY: vertical ? 0.42 : 0.42, animOut: 'none' });
      anim('scalePunch', 0.4);
      break;
    case 'comingSoon':
      Object.assign(t, { fontFamily: mf.title, fontWeight: 400, fontSize: vertical ? 120 : 150, letterSpacing: 10, shadowBlur: 40, shadowOffset: 0, shadowColor: 'rgba(80,160,255,0.85)', posY: 0.42, animOut: 'none' });
      anim('slam', 0.55);
      break;
    case 'islandCode':
      Object.assign(t, {
        uppercase: false,
        fontFamily: mf.code,
        fontWeight: 400,
        fontSize: vertical ? 74 : 84,
        letterSpacing: 6,
        box: true,
        boxColor: '#2a2f7a',
        boxPadding: 34,
        boxRadius: 18,
        shadowBlur: 0,
        shadowOffset: 0,
        posY: vertical ? 0.56 : 0.64,
        animOut: 'none',
      });
      anim('fadeUp', 0.45);
      break;
  }
}

// ---------------------------------------------------------------------------- AI integration helpers

/** Compact description of the footage for the AI prompt. */
export function candidatesForPrompt(cands: ShotCandidate[], limit = 60): string {
  const top = [...cands]
    .filter((c) => c.quality > -0.5)
    .sort((a, b) => Math.max(b.action, b.calm) + b.quality - (Math.max(a.action, a.calm) + a.quality))
    .slice(0, limit);
  return top
    .map(
      (c) =>
        `${c.id} | ${c.mediaName} @${c.srcIn}s | action ${c.action.toFixed(2)} calm ${c.calm.toFixed(2)} motion ${c.motion.toFixed(2)} loud ${c.loudness.toFixed(2)}${c.hud > 0.4 ? ' HUD' : ''}${c.gunfire > 0.35 ? ' GUNFIRE' : ''}${c.aiNote ? ` | ${c.aiNote}` : ''}`,
    )
    .join('\n');
}

export const AI_SYSTEM = `You are a professional game-trailer editor for Fortnite UEFN islands.
You plan trailers from analyzed gameplay footage. Rules from Epic for island trailers:
- No active gunfire on screen (never pick shots marked GUNFIRE).
- A "cinematic" trailer must not show the in-game UI/HUD (shots marked HUD will be auto-cropped, prefer clean shots).
- A "gameplay" trailer may show the UI.
Always answer with ONLY a JSON object, no prose.`;

export function conceptPrompt(styleText: string, style: TrailerStyle, cands: ShotCandidate[]): string {
  return `Trailer request from the creator:
"""${styleText}"""

Parsed settings: mode=${style.mode}, duration=${style.duration}s, aspect=${style.aspect}, mood=${style.mood}.

Candidate shots (id | clip @ start | scores 0..1 | flags):
${candidatesForPrompt(cands)}

Return JSON:
{
 "title": string, "logline": string, "tagline": string, "mood": "hype"|"horror"|"epic"|"fun"|"mystery"|"chill",
 "look": "cinematic"|"horror"|"vibrant"|"none",
 "sections": [ { "name": string, "duration": number, "shotLength": number, "energy": number 0..1,
   "transition": ${TRANSITIONS.map((t) => `"${t.id}"`).join('|')}|null,
   "speed": number 0.5..1, "text": { "text": string, "sub": string, "preset": "slam"|"fadeUp"|"scalePunch"|"lowerThird"|"comingSoon"|"playNow" } | null,
   "endCard": boolean, "shots": [candidate ids in order] } ]
}
Section durations must add up to ${style.duration}. The last section is the end card (endCard true, 3-6 s).
Use each candidate at most once.`;
}

interface AiSection {
  name?: string;
  duration?: number;
  shotLength?: number;
  energy?: number;
  transition?: TransitionType | null;
  speed?: number;
  text?: { text?: string; sub?: string; preset?: string } | null;
  endCard?: boolean;
  shots?: string[];
}

/** Merge an AI JSON answer into a concept. Throws if the answer is unusable. */
export function applyAiConcept(base: TrailerConcept, raw: string): TrailerConcept {
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const j = JSON.parse(json) as { title?: string; logline?: string; tagline?: string; mood?: Mood; look?: LookId; sections?: AiSection[] };
  if (!Array.isArray(j.sections) || !j.sections.length) throw new Error('AI returned no sections');
  const candIds = new Set(base.candidates.map((c) => c.id));
  const style: TrailerStyle = { ...base.style, mood: j.mood ?? base.style.mood, look: j.look ?? base.style.look, tagline: j.tagline ?? base.style.tagline, title: j.title || base.style.title };
  const sections: ConceptSection[] = [];
  const shots: ConceptShot[] = [];
  const used = new Set<string>();
  const total = j.sections.reduce((a, s) => a + (Number(s.duration) || 0), 0) || 1;
  const scale = style.duration / total;
  for (const s of j.sections) {
    const d = Math.max(0.8, (Number(s.duration) || 2) * scale);
    const cs = sec(String(s.name ?? 'Section'), d, clamp(Number(s.shotLength) || 1.5, 0.5, 6), clamp(Number(s.energy) || 0.5, 0, 1), isTransitionType(s.transition) ? s.transition : null, {
      speed: clamp(Number(s.speed) || 1, 0.5, 1),
      endCard: !!s.endCard,
      text: s.text?.text ? { text: s.text.text, sub: s.text.sub, preset: s.text.preset ?? 'fadeUp' } : undefined,
    });
    sections.push(cs);
    const blocked = new Set(base.candidates.filter((c) => c.gunfire > 0.35).map((c) => c.id));
    const ids = (s.shots ?? []).filter((id) => candIds.has(id) && !used.has(id) && !blocked.has(id));
    const n = Math.max(1, ids.length);
    for (const id of ids) {
      used.add(id);
      shots.push({ candidateId: id, sectionId: cs.id, include: true, length: d / n });
    }
  }
  // fill sections the AI left without shots using the local picker
  const empty = sections.filter((s) => !shots.some((x) => x.sectionId === s.id));
  if (empty.length) {
    const extra = pickShots(empty, base.candidates.filter((c) => !used.has(c.id)));
    shots.push(...extra);
  }
  // keep section order for shots
  const order = new Map(sections.map((s, i) => [s.id, i]));
  shots.sort((a, b) => (order.get(a.sectionId)! - order.get(b.sectionId)!));
  return { ...base, title: j.title || base.title, logline: j.logline || base.logline, style, sections, shots, source: 'ai' };
}

export const AI_FRAME_SYSTEM = `You review frames from Fortnite / UEFN gameplay recordings for a trailer editor.
For each numbered frame answer: is the in-game HUD/UI visible (minimap, health/shield bars, inventory, elimination feed, crosshair)?
Is a weapon actively firing (muzzle flash, tracers, firing animation)? How cinematic/attractive is the shot (1-10)?
Answer ONLY with JSON: {"frames":[{"i":number,"hud":boolean,"gunfire":boolean,"cinematic":number,"note":string}]}`;

export function applyAiFrameReview(cands: ShotCandidate[], ids: string[], raw: string): void {
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const j = JSON.parse(json) as { frames?: { i: number; hud?: boolean; gunfire?: boolean; cinematic?: number; note?: string }[] };
  const byId = new Map(cands.map((c) => [c.id, c]));
  for (const f of j.frames ?? []) {
    const c = byId.get(ids[f.i]);
    if (!c) continue;
    if (f.gunfire) {
      c.gunfire = Math.max(c.gunfire, 0.9);
      c.quality -= 1.5;
      if (!c.flags.includes('gunfire (AI)')) c.flags.push('gunfire (AI)');
    }
    if (f.hud) {
      c.hud = Math.max(c.hud, 0.8);
      if (!c.flags.some((x) => x.startsWith('HUD'))) c.flags.push('HUD (AI)');
    }
    if (typeof f.cinematic === 'number') {
      const k = clamp((f.cinematic - 5) / 5, -1, 1);
      c.calm = clamp(c.calm + 0.25 * k, 0, 1);
      c.quality += 0.2 * k;
    }
    if (f.note) c.aiNote = f.note.slice(0, 80);
  }
}
