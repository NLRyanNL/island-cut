// Pure timeline editing operations. They mutate the given (draft) project in place;
// the store wraps them in a clone-and-commit so undo/redo works on snapshots.
import type { AnimProp, Clip, Keyframe, Marker, MediaItem, Project, Track } from './types';
import { hasRamp, sourceOffsetAt, sourceTimeAt, localTimeForSourceOffset } from './keyframes';
import { EPS, snapFrame, uid } from './time';
import { makeTrack } from './defaults';

export const MIN_CLIP = 1 / 60;

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function trackOf(p: Project, id: string): Track | undefined {
  return p.tracks.find((t) => t.id === id);
}

export function clipsOnTrack(p: Project, trackId: string): Clip[] {
  return Object.values(p.clips)
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

export function projectDuration(p: Project): number {
  let d = 0;
  for (const c of Object.values(p.clips)) d = Math.max(d, clipEnd(c));
  return d;
}

export function mediaOf(p: Project, c: Clip): MediaItem | undefined {
  return c.mediaId ? p.media[c.mediaId] : undefined;
}

/** True if the clip is limited by its source length (video/audio, not images/text). */
export function isSourceLimited(p: Project, c: Clip): boolean {
  const m = mediaOf(p, c);
  return !!m && m.kind !== 'image' && m.duration > 0;
}

/** Maximum timeline duration the clip can have given its in-point and source length. */
export function maxDuration(p: Project, c: Clip): number {
  const m = mediaOf(p, c);
  if (!m || m.kind === 'image' || !(m.duration > 0)) return Infinity;
  const avail = Math.max(0, m.duration - c.in);
  if (!hasRamp(c)) return avail / (c.speed || 1);
  // Ramps: binary search the local time where source runs out (assume ramp extends with last speed).
  return localTimeForSourceOffset({ ...c, duration: c.duration * 4 + 60 }, avail);
}

function shiftKeys(keys: Keyframe[] | undefined, delta: number): Keyframe[] | undefined {
  if (!keys) return keys;
  return keys.map((k) => ({ ...k, t: k.t - delta }));
}

function shiftProp(p: AnimProp, delta: number): AnimProp {
  return p.keys ? { ...p, keys: shiftKeys(p.keys, delta) } : p;
}

/** Shift all clip-local keyframe times by -delta (used when the clip start moves within its content). */
export function shiftLocalTimes(c: Clip, delta: number): void {
  if (Math.abs(delta) < EPS) return;
  const tr = c.transform;
  c.transform = {
    x: shiftProp(tr.x, delta),
    y: shiftProp(tr.y, delta),
    scale: shiftProp(tr.scale, delta),
    rotation: shiftProp(tr.rotation, delta),
    opacity: shiftProp(tr.opacity, delta),
  };
  c.volumeKeys = shiftKeys(c.volumeKeys, delta);
  c.speedKeys = shiftKeys(c.speedKeys, delta);
  c.shakes = c.shakes.map((s) => ({ ...s, at: s.at - delta }));
  if (c.reframe) c.reframe = { ...c.reframe, focusX: shiftProp(c.reframe.focusX, delta), focusY: shiftProp(c.reframe.focusY, delta) };
}

/** Move the clip's left edge to newStart (keeping the right edge), adjusting the source in-point. */
export function trimStartTo(p: Project, c: Clip, newStart: number): void {
  const end = clipEnd(c);
  newStart = Math.min(newStart, end - MIN_CLIP);
  const delta = newStart - c.start;
  if (isSourceLimited(p, c) || c.kind === 'video' || c.kind === 'audio') {
    // in-point moves by the source time consumed over delta
    const srcDelta = delta >= 0 ? sourceOffsetAt(c, delta) : delta * (hasRamp(c) ? sourceOffsetAt(c, 0.001) / 0.001 : c.speed || 1);
    let newIn = c.in + srcDelta;
    if (newIn < 0) {
      // clamp at source start
      const allowedSrc = -c.in;
      const allowedDelta = allowedSrc / (c.speed || 1);
      newStart = c.start + allowedDelta;
      newIn = 0;
    }
    const realDelta = newStart - c.start;
    c.in = newIn;
    shiftLocalTimes(c, realDelta);
    c.start = newStart;
    c.duration = end - newStart;
  } else {
    shiftLocalTimes(c, delta);
    c.start = newStart;
    c.duration = end - newStart;
  }
}

/** Move the clip's right edge to newEnd. */
export function trimEndTo(p: Project, c: Clip, newEnd: number): void {
  let d = Math.max(MIN_CLIP, newEnd - c.start);
  d = Math.min(d, maxDuration(p, c));
  c.duration = d;
}

/** Remove everything in [a, b) on a track, trimming or splitting clips that overlap. */
export function clearRange(p: Project, trackId: string, a: number, b: number, exclude: Set<string> = new Set()): void {
  if (b - a < EPS) return;
  for (const c of clipsOnTrack(p, trackId)) {
    if (exclude.has(c.id)) continue;
    const s = c.start;
    const e = clipEnd(c);
    if (e <= a + EPS || s >= b - EPS) continue;
    if (s >= a - EPS && e <= b + EPS) {
      delete p.clips[c.id];
    } else if (s < a && e > b) {
      // split into left and right
      const right = splitClipRaw(p, c, b);
      if (right) right.transitionIn = undefined;
      c.duration = a - s;
    } else if (s < a) {
      c.duration = a - s;
    } else {
      trimStartTo(p, c, b);
      c.transitionIn = undefined;
    }
  }
}

/** Split a single clip at absolute time t (no linked handling). Returns the right part. */
export function splitClipRaw(p: Project, c: Clip, t: number): Clip | null {
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return null;
  const local = t - c.start;
  const right: Clip = structuredClone(c);
  right.id = uid('clp_');
  right.start = t;
  right.duration = c.duration - local;
  if (c.kind === 'video' || c.kind === 'audio') right.in = sourceTimeAt(c, local);
  shiftLocalTimes(right, local);
  right.transitionIn = undefined;
  right.fadeIn = 0;
  c.duration = local;
  c.fadeOut = 0;
  // Text animations: left keeps the in-animation, right keeps the out-animation.
  if (c.text && right.text) {
    c.text = { ...c.text, animOut: 'none' };
    right.text = { ...right.text, animIn: 'none' };
  }
  p.clips[right.id] = right;
  return right;
}

/** All clips linked to the given ones (including themselves). */
export function withLinked(p: Project, ids: Iterable<string>): string[] {
  const set = new Set<string>();
  const links = new Set<string>();
  for (const id of ids) {
    const c = p.clips[id];
    if (!c) continue;
    set.add(id);
    if (c.linkId) links.add(c.linkId);
  }
  if (links.size) for (const c of Object.values(p.clips)) if (c.linkId && links.has(c.linkId)) set.add(c.id);
  return [...set];
}

/** Split clips (and their linked partners) at time t. Returns ids of new right-hand clips. */
export function splitAt(p: Project, ids: string[], t: number): string[] {
  const all = withLinked(p, ids);
  const newLink = new Map<string, string>();
  const out: string[] = [];
  for (const id of all) {
    const c = p.clips[id];
    if (!c) continue;
    const tr = trackOf(p, c.trackId);
    if (tr?.locked) continue;
    const r = splitClipRaw(p, c, t);
    if (r) {
      if (c.linkId) {
        if (!newLink.has(c.linkId)) newLink.set(c.linkId, uid('lnk_'));
        r.linkId = newLink.get(c.linkId);
      }
      out.push(r.id);
    }
  }
  return out;
}

export function deleteClips(p: Project, ids: string[]): void {
  for (const id of withLinked(p, ids)) {
    const c = p.clips[id];
    if (!c) continue;
    if (trackOf(p, c.trackId)?.locked) continue;
    delete p.clips[id];
  }
}

/**
 * Ripple-shift everything at/after `t` on the seed tracks by `delta`, together with the clips linked
 * to them (and so their tracks), so linked video/audio never drifts apart. Locked tracks never move.
 * For a negative delta a track only moves if the space it moves into is empty.
 */
export function rippleShift(p: Project, seedTracks: Iterable<string>, t: number, delta: number): Set<string> {
  const tracks = new Set<string>();
  for (const id of seedTracks) if (!trackOf(p, id)?.locked) tracks.add(id);
  let grew = true;
  while (grew) {
    grew = false;
    const links = new Set<string>();
    for (const c of Object.values(p.clips)) if (tracks.has(c.trackId) && c.start >= t - EPS && c.linkId) links.add(c.linkId);
    for (const c of Object.values(p.clips)) {
      if (!c.linkId || !links.has(c.linkId) || tracks.has(c.trackId)) continue;
      if (trackOf(p, c.trackId)?.locked) continue;
      if (delta < 0 && !isRangeFree(p, c.trackId, t + delta, t)) continue;
      tracks.add(c.trackId);
      grew = true;
    }
  }
  for (const c of Object.values(p.clips)) if (tracks.has(c.trackId) && c.start >= t - EPS) c.start = Math.max(0, c.start + delta);
  return tracks;
}

/** Delete clips and close the gaps on their tracks (linked clips elsewhere move along). */
export function rippleDelete(p: Project, ids: string[]): void {
  const all = withLinked(p, ids).map((id) => p.clips[id]).filter(Boolean) as Clip[];
  // group by link so a video + its audio close ONE gap, not two
  const groups = new Map<string, { a: number; b: number; tracks: Set<string> }>();
  for (const c of all) {
    if (trackOf(p, c.trackId)?.locked) continue;
    const key = c.linkId ?? c.id;
    const g = groups.get(key) ?? { a: Infinity, b: -Infinity, tracks: new Set<string>() };
    g.a = Math.min(g.a, c.start);
    g.b = Math.max(g.b, clipEnd(c));
    g.tracks.add(c.trackId);
    groups.set(key, g);
    delete p.clips[c.id];
  }
  const list = [...groups.values()].sort((x, y) => y.a - x.a);
  for (const g of list) {
    // only close the part of the range that is actually empty on every seed track
    const len = g.b - g.a;
    if (len <= EPS) continue;
    if (![...g.tracks].every((tid) => isRangeFree(p, tid, g.a, g.b))) continue;
    rippleShift(p, g.tracks, g.b - EPS / 2, -len);
  }
}

/** Close the gap at time t on a track (ripple-delete empty space). */
export function closeGapAt(p: Project, trackId: string, t: number): boolean {
  if (trackOf(p, trackId)?.locked) return false;
  const clips = clipsOnTrack(p, trackId);
  let prevEnd = 0;
  for (const c of clips) {
    if (t >= prevEnd - EPS && t < c.start - EPS) {
      rippleShift(p, [trackId], c.start, -(c.start - prevEnd));
      return true;
    }
    prevEnd = Math.max(prevEnd, clipEnd(c));
  }
  return false;
}

export interface ClipMove {
  id: string;
  start: number;
  trackId: string;
}

/** Move clips to new positions/tracks with overwrite behaviour (clips underneath get trimmed). */
export function moveClips(p: Project, moves: ClipMove[]): void {
  const moving = new Set(moves.map((m) => m.id));
  for (const m of moves) {
    const c = p.clips[m.id];
    if (!c) continue;
    c.start = Math.max(0, m.start);
    c.trackId = m.trackId;
  }
  for (const m of moves) {
    const c = p.clips[m.id];
    if (!c) continue;
    clearRange(p, c.trackId, c.start, clipEnd(c), moving);
  }
}

/** Insert a new clip with overwrite behaviour. */
export function placeClip(p: Project, c: Clip): void {
  p.clips[c.id] = c;
  clearRange(p, c.trackId, c.start, clipEnd(c), new Set([c.id]));
}

export function isRangeFree(p: Project, trackId: string, a: number, b: number, exclude: Set<string> = new Set()): boolean {
  return !clipsOnTrack(p, trackId).some((c) => !exclude.has(c.id) && c.start < b - EPS && clipEnd(c) > a + EPS);
}

export function tracksOfKind(p: Project, kind: Track['kind']): Track[] {
  return p.tracks.filter((t) => t.kind === kind);
}

/** Add a new track of a kind, placed with its siblings. */
export function addTrack(p: Project, kind: Track['kind']): Track {
  const same = tracksOfKind(p, kind);
  let name: string;
  if (kind === 'video') name = `V${same.length + 1}`;
  else if (kind === 'audio') name = `A${same.length + 1}`;
  else name = `T${same.length + 1}`;
  const t = makeTrack(kind, name, kind === 'audio' ? 'sfx' : undefined);
  if (kind === 'video') {
    // new video track goes on top of the other video tracks
    const firstVideo = p.tracks.findIndex((x) => x.kind === 'video');
    p.tracks.splice(firstVideo < 0 ? p.tracks.length : firstVideo, 0, t);
  } else if (kind === 'text') {
    p.tracks.splice(0, 0, t);
  } else {
    p.tracks.push(t);
  }
  return t;
}

export function removeTrack(p: Project, trackId: string): void {
  const t = trackOf(p, trackId);
  if (!t) return;
  if (tracksOfKind(p, t.kind).length <= 1) return;
  for (const c of clipsOnTrack(p, trackId)) delete p.clips[c.id];
  p.tracks = p.tracks.filter((x) => x.id !== trackId);
}

/** Find an audio track that is free over [a,b), preferring a role, or create one. */
export function findFreeAudioTrack(p: Project, a: number, b: number, prefer: Track['role'] = 'game'): Track {
  const audio = tracksOfKind(p, 'audio');
  const ordered = [...audio.filter((t) => t.role === prefer), ...audio.filter((t) => t.role !== prefer)];
  for (const t of ordered) if (!t.locked && isRangeFree(p, t.id, a, b)) return t;
  return addTrack(p, 'audio');
}

/** Extract a video clip's audio to a linked audio clip on its own track. */
export function extractAudio(p: Project, clipId: string): Clip | null {
  const v = p.clips[clipId];
  if (!v || v.kind !== 'video') return null;
  const m = mediaOf(p, v);
  if (!m || !m.hasAudio || v.audioDetached) return null;
  const track = findFreeAudioTrack(p, v.start, clipEnd(v), 'game');
  const a: Clip = structuredClone(v);
  a.id = uid('clp_');
  a.kind = 'audio';
  a.trackId = track.id;
  a.name = `${v.name} (audio)`;
  a.transitionIn = undefined;
  a.shakes = [];
  a.text = undefined;
  const link = v.linkId ?? uid('lnk_');
  a.linkId = link;
  v.linkId = link;
  v.audioDetached = true;
  p.clips[a.id] = a;
  return a;
}

export function unlinkClips(p: Project, ids: string[]): void {
  const links = new Set(ids.map((id) => p.clips[id]?.linkId).filter(Boolean) as string[]);
  for (const c of Object.values(p.clips)) if (c.linkId && links.has(c.linkId)) c.linkId = undefined;
}

export function linkClips(p: Project, ids: string[]): void {
  if (ids.length < 2) return;
  const l = uid('lnk_');
  for (const id of ids) if (p.clips[id]) p.clips[id].linkId = l;
}

// ---------------- Snapping ----------------

export interface SnapOptions {
  playhead?: number;
  excludeIds?: Set<string>;
  includeBeats?: boolean;
  includeMarkers?: boolean;
}

export function snapPoints(p: Project, o: SnapOptions): number[] {
  const pts: number[] = [0];
  if (o.playhead !== undefined) pts.push(o.playhead);
  for (const c of Object.values(p.clips)) {
    if (o.excludeIds?.has(c.id)) continue;
    pts.push(c.start, clipEnd(c));
  }
  if (o.includeMarkers !== false) for (const m of p.markers) if (m.kind !== 'beat' || o.includeBeats) pts.push(m.time);
  if (p.inPoint !== undefined) pts.push(p.inPoint);
  if (p.outPoint !== undefined) pts.push(p.outPoint);
  return pts.sort((a, b) => a - b);
}

/** Snap time t to the nearest point within threshold. Returns [snappedTime, snapPoint|null]. */
export function snapTime(t: number, points: number[], threshold: number): [number, number | null] {
  let best: number | null = null;
  let bd = threshold;
  // binary search for insertion point
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 2); i < Math.min(points.length, lo + 2); i++) {
    const d = Math.abs(points[i] - t);
    if (d <= bd) {
      bd = d;
      best = points[i];
    }
  }
  return best === null ? [t, null] : [best, best];
}

/** Snap a moving range [s, s+len): tries both edges, returns the adjusted start. */
export function snapRange(s: number, len: number, points: number[], threshold: number): [number, number | null] {
  const [s1, p1] = snapTime(s, points, threshold);
  const [e1, p2] = snapTime(s + len, points, threshold);
  const d1 = p1 === null ? Infinity : Math.abs(s1 - s);
  const d2 = p2 === null ? Infinity : Math.abs(e1 - (s + len));
  if (d1 === Infinity && d2 === Infinity) return [s, null];
  return d1 <= d2 ? [s1, p1] : [e1 - len, p2];
}

// ---------------- Markers ----------------

export function addMarker(p: Project, time: number, kind: Marker['kind'] = 'user', label = '', color = '#ffb020'): Marker {
  const m: Marker = { id: uid('mrk_'), time, label, color, kind };
  p.markers.push(m);
  p.markers.sort((a, b) => a.time - b.time);
  return m;
}

/** Slice a clip at every Nth beat marker inside it ("auto-cut to beat"). Returns resulting clip ids. */
export function autoCutToBeats(p: Project, clipId: string, everyN: number, fps: number): string[] {
  const c = p.clips[clipId];
  if (!c) return [];
  const beats = p.markers.filter((m) => m.kind === 'beat').map((m) => m.time);
  const inside = beats.filter((t) => t > c.start + 1 / fps && t < clipEnd(c) - 1 / fps);
  // Use a global beat index so "every 2nd beat" aligns with the musical grid.
  const picked = inside.filter((t) => beats.indexOf(t) % everyN === 0);
  const ids = [c.id];
  let cur = c;
  for (const t of picked) {
    const r = splitAt(p, [cur.id], snapFrame(t, fps));
    const right = r.find((id) => p.clips[id]?.trackId === c.trackId);
    if (!right) continue;
    ids.push(right);
    cur = p.clips[right];
  }
  return ids;
}

/** Remap a whole project's clips to new frame boundaries (used after fps change). */
export function quantizeProject(p: Project): void {
  const fps = p.settings.fps;
  for (const c of Object.values(p.clips)) {
    const s = snapFrame(c.start, fps);
    const e = snapFrame(clipEnd(c), fps);
    c.start = s;
    c.duration = Math.max(1 / fps, e - s);
  }
}
