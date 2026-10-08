// High-level editor actions used by the UI, menus and keyboard shortcuts.
import type { Clip, MediaItem, Project, TransitionType, ExportJob } from '../../shared/types';
import {
  commit,
  getState,
  loadProjectState,
  redo as storeRedo,
  setRT,
  setState,
  setUI,
  toast,
  undo as storeUndo,
} from './store';
import { basename, clipFromMedia, createProject, ALL_MEDIA_EXTS, AUDIO_EXTS, makeClip, defaultText, defaultAdjust } from '../../shared/defaults';
import {
  addMarker,
  autoCutToBeats,
  clipEnd,
  clipsOnTrack,
  deleteClips,
  extractAudio as opExtractAudio,
  placeClip,
  projectDuration,
  rippleDelete,
  splitAt,
  trackOf,
  tracksOfKind,
  unlinkClips,
  withLinked,
  findFreeAudioTrack,
  isRangeFree,
  addTrack,
  closeGapAt,
  rippleShift,
} from '../../shared/timelineOps';
import { snapFrame, uid, clamp, EPS } from '../../shared/time';
import { sourceTimeAt, sourceSpan } from '../../shared/keyframes';

const api = () => window.api;

// ------------------------------------------------------------------ media

export function mediaName(path: string): string {
  return basename(path);
}

export async function importFiles(paths: string[], folder?: MediaItem['folder']): Promise<MediaItem[]> {
  const fresh = paths.filter((p) => ALL_MEDIA_EXTS.includes(p.split('.').pop()?.toLowerCase() ?? ''));
  const rejected = paths.filter((p) => !fresh.includes(p));
  if (rejected.length) toast(`Skipped unsupported file${rejected.length > 1 ? 's' : ''}: ${rejected.map(basename).join(', ')}`, 'error');
  if (!fresh.length) return [];
  const existing = new Map(Object.values(getState().project.media).map((m) => [m.path, m]));
  const toProbe = fresh.filter((p) => !existing.has(p));
  setRT({ busy: `Adding ${toProbe.length} file${toProbe.length === 1 ? '' : 's'}…`, importing: toProbe.map(basename) });
  let results: Awaited<ReturnType<typeof window.api.probe>>;
  try {
    results = await api().probe(toProbe);
  } catch (e) {
    toast(`Import failed: ${(e as Error).message}`, 'error');
    return [];
  } finally {
    setRT({ busy: null, importing: [] });
  }
  const added: MediaItem[] = [];
  results.forEach((r, i) => {
    const path = toProbe[i];
    if (!r.ok) {
      toast(`${basename(path)}: ${r.error}`, 'error');
      return;
    }
    const isAudio = r.kind === 'audio';
    const ext = path.split('.').pop()!.toLowerCase();
    const m: MediaItem = {
      id: uid('med_'),
      kind: r.kind!,
      name: basename(path),
      path,
      folder: folder ?? (isAudio && AUDIO_EXTS.includes(ext) && r.duration > 20 ? 'music' : isAudio ? 'sfx' : 'media'),
      duration: r.duration,
      width: r.width,
      height: r.height,
      fps: r.fps,
      hasVideo: r.hasVideo,
      hasAudio: r.hasAudio,
      audioChannels: r.audioChannels,
      sampleRate: r.sampleRate,
      codec: r.codec,
      fileSize: r.fileSize,
      mtimeMs: r.mtimeMs,
    };
    added.push(m);
  });
  if (added.length) {
    commit((p) => {
      for (const m of added) p.media[m.id] = m;
    });
    for (const m of added) ensureMediaRuntime(m);
    toast(`Imported ${added.length} file${added.length > 1 ? 's' : ''}`, 'success', 2000);
  }
  return [...added, ...fresh.filter((p) => existing.has(p)).map((p) => existing.get(p)!)];
}

export type PreviewQuality = 'smooth' | 'high' | 'original';
export function previewQuality(): PreviewQuality {
  return getState().rt.settings?.previewQuality ?? 'high';
}
/** Height of the preview copies for the current preview quality. */
export function previewProxyHeight(): number {
  return previewQuality() === 'smooth' ? 540 : 1080;
}
/** Switch preview quality: makes new preview copies of the clips at the new size (cached, so switching back is instant). */
export async function setPreviewQuality(q: PreviewQuality): Promise<void> {
  if (q === previewQuality()) return;
  const before = previewProxyHeight();
  setRT({ settings: await api().updateSettings({ previewQuality: q }) });
  if (previewProxyHeight() !== before) {
    const vids = Object.values(getState().project.media).filter((m) => m.kind === 'video' && !m.missing);
    setRT((r) => {
      const proxies = { ...r.proxies };
      for (const m of vids) delete proxies[m.id];
      return { proxies };
    });
    for (const m of vids) ensureMediaRuntime(m);
  }
  toast(q === 'smooth' ? 'Preview: Smooth (lighter on slow PCs)' : q === 'high' ? 'Preview: High quality (1080p)' : 'Preview: Original (full resolution, needs a fast PC)', 'info', 2200);
}

/** Kick off thumbnail, proxy and waveform generation for a media item (cached on disk). */
export function ensureMediaRuntime(m: MediaItem): void {
  const rt = getState().rt;
  if (m.missing) return;
  if ((m.kind === 'video' || m.kind === 'image') && !rt.thumbs[m.id]) {
    api()
      .thumbnail(m.path, m.kind, m.duration)
      .then((url) => url && setRT((r) => ({ thumbs: { ...r.thumbs, [m.id]: url } })));
  }
  if (m.kind === 'video' && !rt.proxies[m.id]) {
    setRT((r) => ({ proxies: { ...r.proxies, [m.id]: { mediaId: m.id, state: 'queued', progress: 0 } } }));
    api().requestProxy(m);
  }
  if (m.hasAudio && !rt.waveforms[m.path]) {
    api()
      .waveform(m.path)
      .then((w) => w && setRT((r) => ({ waveforms: { ...r.waveforms, [m.path]: w } })));
  }
}

export function removeMedia(ids: string[]): void {
  const p = getState().project;
  const used = Object.values(p.clips).filter((c) => c.mediaId && ids.includes(c.mediaId));
  commit((d) => {
    for (const c of used) delete d.clips[c.id];
    for (const id of ids) delete d.media[id];
  });
}

// ------------------------------------------------------------------ timeline helpers

export function fps(): number {
  return getState().project.settings.fps;
}

export function selectedClips(): Clip[] {
  const s = getState();
  return s.ui.selection.map((id) => s.project.clips[id]).filter(Boolean) as Clip[];
}

export function select(ids: string[], additive = false): void {
  const s = getState();
  const next = additive ? Array.from(new Set([...s.ui.selection, ...ids])) : ids;
  setUI({ selection: withLinked(s.project, next) });
}

export function toggleSelect(id: string): void {
  const s = getState();
  const linked = withLinked(s.project, [id]);
  if (s.ui.selection.includes(id)) setUI({ selection: s.ui.selection.filter((x) => !linked.includes(x)) });
  else setUI({ selection: Array.from(new Set([...s.ui.selection, ...linked])) });
}

export function addMediaToTimeline(mediaId: string, trackId: string | null, start: number): string | null {
  const s = getState();
  const p = s.project;
  const m = p.media[mediaId];
  if (!m) return null;
  const f = p.settings.fps;
  let track = trackId ? trackOf(p, trackId) : undefined;
  const wantKind = m.kind === 'audio' ? 'audio' : 'video';
  if (!track || track.kind !== wantKind) {
    // pick first unlocked track of the right kind (V1 for video, role-matched audio)
    const candidates = wantKind === 'video' ? [...tracksOfKind(p, 'video')].reverse() : tracksOfKind(p, 'audio');
    const role = m.folder === 'music' ? 'music' : m.folder === 'sfx' ? 'sfx' : 'game';
    track = candidates.find((t) => !t.locked && (wantKind === 'video' || t.role === role)) ?? candidates.find((t) => !t.locked);
  }
  if (!track || track.locked) {
    toast('That track is locked', 'error');
    return null;
  }
  const c = clipFromMedia(m, track.id, snapFrame(Math.max(0, start), f), f);
  // Images on upper tracks are usually overlays (logos, thumbnails): start them small in a corner.
  const videoTracks = tracksOfKind(p, 'video');
  if (m.kind === 'image' && track.id !== videoTracks[videoTracks.length - 1]?.id) {
    c.fit = 'fit';
    c.transform.scale = { value: 0.3 };
    c.transform.x = { value: Math.round(p.settings.width * 0.32) };
    c.transform.y = { value: -Math.round(p.settings.height * 0.3) };
  }
  commit((d) => placeClip(d, c));
  setUI({ selection: [c.id] });
  return c.id;
}

/** Insert media at the end of a track (used by the bin's "Append" and templates). */
export function appendToTimeline(mediaId: string): void {
  const p = getState().project;
  const m = p.media[mediaId];
  if (!m) return;
  const kind = m.kind === 'audio' ? 'audio' : 'video';
  const t = kind === 'video' ? tracksOfKind(p, 'video').slice(-1)[0] : tracksOfKind(p, 'audio')[0];
  const end = clipsOnTrack(p, t.id).reduce((a, c) => Math.max(a, clipEnd(c)), 0);
  addMediaToTimeline(mediaId, t.id, end);
}

export function splitAtPlayhead(): void {
  const s = getState();
  const t = snapFrame(s.ui.playhead, fps());
  let ids = s.ui.selection.filter((id) => {
    const c = s.project.clips[id];
    return c && c.start < t - EPS && clipEnd(c) > t + EPS;
  });
  if (!ids.length) {
    ids = Object.values(s.project.clips)
      .filter((c) => c.start < t - EPS && clipEnd(c) > t + EPS && !trackOf(s.project, c.trackId)?.locked)
      .map((c) => c.id);
  }
  if (!ids.length) return;
  let newIds: string[] = [];
  commit((d) => {
    newIds = splitAt(d, ids, t);
  });
  if (newIds.length) setUI({ selection: newIds });
}

export function deleteSelection(ripple: boolean): void {
  const s = getState();
  if (!s.ui.selection.length) {
    if (ripple) {
      // ripple-delete the empty gap under the playhead (first track that has one)
      for (const tr of s.project.tracks) {
        const test = structuredClone(s.project);
        if (closeGapAt(test, tr.id, s.ui.playhead)) {
          commit((d) => {
            closeGapAt(d, tr.id, s.ui.playhead);
          });
          return;
        }
      }
    }
    return;
  }
  const ids = [...s.ui.selection];
  commit((d) => (ripple ? rippleDelete(d, ids) : deleteClips(d, ids)));
  setUI({ selection: [] });
}

export function addMarkerAtPlayhead(): void {
  const t = snapFrame(getState().ui.playhead, fps());
  commit((d) => {
    addMarker(d, t, 'user', `Marker ${d.markers.filter((m) => m.kind === 'user').length + 1}`);
  });
}

export function setPlayhead(t: number): void {
  const s = getState();
  const dur = Math.max(projectDuration(s.project), 0);
  setUI({ playhead: clamp(snapFrame(t, s.project.settings.fps), 0, Math.max(dur, 0) + 600) });
}

export function stepFrames(n: number): void {
  const s = getState();
  setUI({ playing: false, rate: 1 });
  setPlayhead(s.ui.playhead + n / s.project.settings.fps);
}

export function togglePlay(): void {
  const s = getState();
  if (s.ui.playing) setUI({ playing: false, rate: 1 });
  else {
    // restart from the beginning when at the end
    const dur = projectDuration(s.project);
    if (s.ui.playhead >= dur - 1 / fps()) setUI({ playhead: 0 });
    setUI({ playing: true, rate: 1 });
  }
}

export function shuttle(dir: -1 | 0 | 1): void {
  const s = getState();
  if (dir === 0) {
    setUI({ playing: false, rate: 1 });
    return;
  }
  let rate = s.ui.playing ? s.ui.rate : 0;
  if (dir > 0) rate = rate <= 0 ? 1 : Math.min(8, rate * 2);
  else rate = rate >= 0 ? -1 : Math.max(-8, rate * 2);
  setUI({ playing: true, rate });
}

export function zoomBy(factor: number, anchorTime?: number): void {
  const s = getState();
  const z = clamp(s.ui.zoom * factor, 2, 2400);
  const anchor = anchorTime ?? s.ui.playhead;
  // keep the anchor at the same screen position
  const screenX = (anchor - s.ui.scrollX) * s.ui.zoom;
  const scrollX = Math.max(0, anchor - screenX / z);
  setUI({ zoom: z, scrollX });
}

export function zoomToFit(widthPx: number): void {
  const d = Math.max(5, projectDuration(getState().project));
  setUI({ zoom: clamp((widthPx - 40) / d, 2, 2400), scrollX: 0 });
}

// ------------------------------------------------------------------ clip operations

export function extractAudio(clipId: string): void {
  let made: Clip | null = null;
  commit((d) => {
    made = opExtractAudio(d, clipId);
  });
  if (!made) toast('This clip has no audio to extract (or it was already extracted).', 'error');
  else toast('Audio extracted to its own track (linked). Right-click → Unlink to edit it separately.', 'success');
}

export function unlink(ids: string[]): void {
  commit((d) => unlinkClips(d, ids));
}

export function relinkAudioBack(clipId: string): void {
  // re-attach: delete linked audio clip, restore video's own audio
  const p = getState().project;
  const v = p.clips[clipId];
  if (!v) return;
  commit((d) => {
    const vv = d.clips[clipId];
    for (const c of Object.values(d.clips)) if (c.linkId && c.linkId === vv.linkId && c.kind === 'audio') delete d.clips[c.id];
    vv.audioDetached = false;
    vv.linkId = undefined;
  });
}

export function updateClips(ids: string[], fn: (c: Clip, p: Project) => void): void {
  commit((d) => {
    for (const id of ids) if (d.clips[id]) fn(d.clips[id], d);
  });
}

export function setTransition(clipId: string, type: TransitionType | null, duration = 0.5): void {
  commit((d) => {
    const c = d.clips[clipId];
    if (!c) return;
    c.transitionIn = type ? { type, duration } : undefined;
  });
}

export async function detectBeatsFor(clipOrMediaId: string): Promise<void> {
  const s = getState();
  const clip = s.project.clips[clipOrMediaId];
  const m = clip ? s.project.media[clip.mediaId ?? ''] : s.project.media[clipOrMediaId];
  if (!m || !m.hasAudio) {
    toast('Select a music clip with audio', 'error');
    return;
  }
  setRT({ busy: `Detecting beats in ${m.name}…` });
  try {
    const r = await api().detectBeats(m.path);
    if (!r.beats.length) {
      toast('No clear beat found in this track', 'error');
      return;
    }
    commit((d) => {
      d.media[m.id].beats = r.beats;
      d.media[m.id].bpm = r.bpm;
      // place beat markers for every timeline clip that uses this media
      d.markers = d.markers.filter((mk) => mk.kind !== 'beat');
      const clips = Object.values(d.clips).filter((c) => c.mediaId === m.id);
      const downs = new Set(r.downbeats.map((b) => b.toFixed(3)));
      for (const c of clips) {
        const a = c.in;
        const b = c.in + sourceSpan(c);
        for (const bt of r.beats) {
          if (bt < a || bt > b) continue;
          // timeline time where this source time plays (constant speed assumption for markers)
          const t = c.start + (bt - c.in) / (c.speed || 1);
          addMarker(d, snapFrame(t, d.settings.fps), 'beat', downs.has(bt.toFixed(3)) ? 'downbeat' : 'beat', downs.has(bt.toFixed(3)) ? '#ff4d6d' : '#4dd0ff');
        }
      }
    });
    toast(`${r.bpm} BPM — ${r.beats.length} beats marked`, 'success');
  } catch (e) {
    toast(`Beat detection failed: ${(e as Error).message}`, 'error');
  } finally {
    setRT({ busy: null });
  }
}

export function autoCut(clipId: string, everyN: number): void {
  const p = getState().project;
  if (!p.markers.some((m) => m.kind === 'beat')) {
    toast('No beat markers yet. Right-click your music clip → Detect Beats first.', 'error');
    return;
  }
  let ids: string[] = [];
  commit((d) => {
    ids = autoCutToBeats(d, clipId, everyN, d.settings.fps);
  });
  toast(`Cut into ${ids.length} pieces`, 'success');
}

export async function reverseClip(clipId: string): Promise<void> {
  const p = getState().project;
  const c = p.clips[clipId];
  const m = c?.mediaId ? p.media[c.mediaId] : undefined;
  if (!c || !m || c.kind !== 'video') {
    toast('Reverse works on video clips', 'error');
    return;
  }
  if (m.derivedFrom?.op === 'reverse') {
    // un-reverse: go back to the original media
    const orig = p.media[m.derivedFrom.mediaId];
    if (!orig) return;
    const span = sourceSpan(c);
    const offsetInDerived = c.in;
    const origIn = (m.derivedFrom.srcOut ?? 0) - offsetInDerived - span;
    commit((d) => {
      const cc = d.clips[clipId];
      cc.mediaId = orig.id;
      cc.in = Math.max(0, origIn);
      cc.reversed = false;
    });
    return;
  }
  const srcIn = c.in;
  const srcOut = Math.min(m.duration, c.in + sourceSpan(c));
  setRT({ busy: 'Rendering reversed clip…' });
  try {
    const r = await api().makeDerived({ op: 'reverse', sourcePath: m.path, srcIn, srcOut, fps: m.fps });
    const probe = (await api().probe([r.path]))[0];
    const nm: MediaItem = {
      ...m,
      id: uid('med_'),
      name: `${m.name} (reversed)`,
      path: r.path,
      duration: probe.duration,
      fileSize: probe.fileSize,
      mtimeMs: probe.mtimeMs,
      hasAudio: probe.hasAudio,
      derivedFrom: { mediaId: m.id, op: 'reverse', srcIn, srcOut },
      folder: 'media',
    };
    commit((d) => {
      d.media[nm.id] = nm;
      const cc = d.clips[clipId];
      cc.mediaId = nm.id;
      cc.in = 0;
      cc.reversed = true;
    });
    ensureMediaRuntime(nm);
    toast('Clip reversed', 'success');
  } catch (e) {
    toast(`Reverse failed: ${(e as Error).message}`, 'error');
  } finally {
    setRT({ busy: null });
  }
}

export async function freezeFrame(clipId?: string, holdSec = 1.5): Promise<void> {
  const s = getState();
  const t = snapFrame(s.ui.playhead, fps());
  const c =
    (clipId && s.project.clips[clipId]) ||
    Object.values(s.project.clips)
      .filter((x) => x.kind === 'video' && x.start <= t + EPS && clipEnd(x) > t + EPS)
      .sort((a, b) => trackIndex(b) - trackIndex(a))[0];
  if (!c || c.kind !== 'video') {
    toast('Put the playhead over a video clip to freeze a frame', 'error');
    return;
  }
  const m = s.project.media[c.mediaId!];
  const srcT = sourceTimeAt(c, t - c.start);
  setRT({ busy: 'Grabbing frame…' });
  try {
    const r = await api().makeDerived({ op: 'freeze', sourcePath: m.path, srcIn: srcT, fps: m.fps });
    const probe = (await api().probe([r.path]))[0];
    const img: MediaItem = {
      id: uid('med_'),
      kind: 'image',
      name: `${m.name} freeze @${srcT.toFixed(2)}s`,
      path: r.path,
      folder: 'media',
      duration: 0,
      width: probe.width,
      height: probe.height,
      fps: 0,
      hasVideo: true,
      hasAudio: false,
      audioChannels: 0,
      sampleRate: 0,
      codec: 'png',
      fileSize: probe.fileSize,
      mtimeMs: probe.mtimeMs,
      derivedFrom: { mediaId: m.id, op: 'freeze', srcIn: srcT },
    };
    const f = fps();
    const hold = snapFrame(holdSec, f);
    commit((d) => {
      d.media[img.id] = img;
      // split the clip at the playhead and push everything after it on this track to the right
      const right = splitAt(d, [c.id], t);
      const trackId = c.trackId;
      void right;
      rippleShift(d, [trackId], t, hold); // linked audio (and its track) moves along
      const fc = makeClip('image', trackId, t, hold, { mediaId: img.id, name: 'Freeze frame', fit: c.fit, transform: structuredClone(c.transform), color: structuredClone(c.color) });
      fc.transform.x.keys = undefined;
      fc.transform.y.keys = undefined;
      fc.transform.scale.keys = undefined;
      fc.transform.rotation.keys = undefined;
      fc.transform.opacity.keys = undefined;
      d.clips[fc.id] = fc;
    });
    toast('Freeze frame inserted', 'success');
  } catch (e) {
    toast(`Freeze frame failed: ${(e as Error).message}`, 'error');
  } finally {
    setRT({ busy: null });
  }
}

function trackIndex(c: Clip): number {
  const p = getState().project;
  // higher = visually on top
  const vis = p.tracks.filter((t) => t.kind !== 'audio');
  return vis.length - vis.findIndex((t) => t.id === c.trackId);
}

export function addTextClip(preset?: Partial<Clip>): void {
  const s = getState();
  const p = s.project;
  const f = fps();
  const t = snapFrame(s.ui.playhead, f);
  let track = tracksOfKind(p, 'text').find((tr) => !tr.locked && isRangeFree(p, tr.id, t, t + 3));
  let newId = '';
  commit((d) => {
    if (!track) track = addTrack(d, 'text');
    const c = makeClip('text', track.id, t, preset?.duration ?? 3, { name: 'Text', fit: 'fit', text: defaultText(), ...preset });
    placeClip(d, c);
    newId = c.id;
  });
  setUI({ selection: [newId], inspectorTab: 'text' });
}

export function addLetterboxClip(): void {
  const s = getState();
  const p = s.project;
  const f = fps();
  const t = snapFrame(s.ui.playhead, f);
  // place on the topmost video track that is free, else add one
  let track = tracksOfKind(p, 'video').find((tr) => !tr.locked && isRangeFree(p, tr.id, t, t + 5));
  let newId = '';
  commit((d) => {
    if (!track) track = addTrack(d, 'video');
    const c = makeClip('adjust', track.id, t, 5, { name: 'Letterbox 2.39:1', adjust: defaultAdjust() });
    placeClip(d, c);
    newId = c.id;
  });
  setUI({ selection: [newId] });
}

// ------------------------------------------------------------------ project files

export async function newProject(aspect: Project['settings']['aspect'] = '16:9', fpsVal = 60, project?: Project): Promise<void> {
  if (!(await confirmDiscard())) return;
  loadProjectState(project ?? createProject('Untitled Trailer', aspect, fpsVal), null);
  updateTitle();
}

export async function confirmDiscard(): Promise<boolean> {
  const s = getState();
  if (!s.dirty || Object.keys(s.project.clips).length === 0) return true;
  const r = await api().confirm({
    message: 'Save changes to this project?',
    detail: 'Your changes will be lost if you don\'t save them.',
    buttons: ['Save', 'Don\'t Save', 'Cancel'],
    cancelId: 2,
    defaultId: 0,
  });
  if (r === 2) return false;
  if (r === 0) return await saveProject(false);
  return true;
}

export async function saveProject(saveAs: boolean): Promise<boolean> {
  const s = getState();
  let path = s.projectPath;
  if (!path || saveAs) {
    path = await api().saveFile({
      title: 'Save Project',
      defaultPath: `${s.project.name.replace(/[\\/:*?"<>|]/g, '_')}.islandcut.json`,
      filters: [{ name: 'Trailer Project', extensions: ['json'] }],
    });
    if (!path) return false;
  }
  try {
    const name = basename(path).replace(/(\.islandcut|\.uts)?\.json$/i, '');
    const newName = s.projectPath && !saveAs ? s.project.name : name;
    const rev = s.ui.revision;
    await api().saveProject({ ...s.project, name: newName }, path);
    // edits made while the file was being written must survive: only update name/path/dirty
    const now = getState();
    setState({ project: { ...now.project, name: newName }, projectPath: path, dirty: now.ui.revision !== rev });
    updateTitle();
    toast('Project saved', 'success', 1500);
    return true;
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

export async function openProject(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  if (!path) {
    const r = await api().openFiles({ title: 'Open Project', filters: [{ name: 'Trailer Project', extensions: ['json'] }] });
    if (!r.length) return;
    path = r[0];
  }
  try {
    const p = await api().loadProject(path);
    loadProjectState(p, path.includes('autosave') ? null : path);
    updateTitle();
    for (const m of Object.values(p.media)) ensureMediaRuntime(m);
    await loadProjectFonts(p);
    if (Object.values(p.media).some((m) => m.missing)) setUI({ dialog: 'relink' });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export async function loadProjectFonts(p: Project): Promise<void> {
  for (const f of p.fonts) {
    if (getState().rt.loadedFonts[f.family]) continue;
    try {
      const bytes = await api().readBytes(f.path);
      const face = new FontFace(f.family, bytes.buffer as ArrayBuffer);
      await face.load();
      document.fonts.add(face);
      setRT((r) => ({ loadedFonts: { ...r.loadedFonts, [f.family]: true } }));
    } catch {
      toast(`Font file missing: ${f.path}`, 'error');
    }
  }
}

export function updateTitle(): void {
  const s = getState();
  api().setTitle(`${s.project.name}${s.dirty ? ' *' : ''} — IslandCut`);
}

export function undo(): void {
  storeUndo();
}
export function redo(): void {
  storeRedo();
}

export function newJobId(): string {
  return uid('job_');
}

export type { ExportJob };

/** Find a free audio track for a new SFX placed at time t. */
export function sfxTrackAt(t: number, dur: number): string | null {
  const p = structuredClone(getState().project);
  const n = p.tracks.length;
  const tr = findFreeAudioTrack(p, t, t + dur, 'sfx');
  return p.tracks.length === n ? tr.id : null;
}
