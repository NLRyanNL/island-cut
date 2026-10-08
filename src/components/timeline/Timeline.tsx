import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  beginTx,
  cancelTx,
  commit,
  endTx,
  getState,
  setUI,
  txBaseProject,
  updateTx,
  useStore,
  toast,
} from '../../store/store';
import {
  addMediaToTimeline,
  addMarkerAtPlayhead,
  addLetterboxClip,
  addTextClip,
  autoCut,
  deleteSelection,
  detectBeatsFor,
  extractAudio,
  freezeFrame,
  importFiles,
  relinkAudioBack,
  reverseClip,
  select,
  setPlayhead,
  setTransition,
  splitAtPlayhead,
  toggleSelect,
  unlink,
  zoomBy,
  zoomToFit,
  updateClips,
} from '../../store/actions';
import type { Clip, Keyframe, Project, Track, TransitionType } from '../../../shared/types';
import {
  addTrack,
  clipEnd,
  clipsOnTrack,
  moveClips,
  removeTrack,
  snapPoints,
  snapRange,
  snapTime,
  trimEndTo,
  trimStartTo,
  withLinked,
  ClipMove,
  maxDuration,
  MIN_CLIP,
} from '../../../shared/timelineOps';
import { clamp, EPS, snapFrame, uid } from '../../../shared/time';
import { evalKeys, sortKeys } from '../../../shared/keyframes';
import { Ruler } from './Ruler';
import { ClipCanvas } from './ClipCanvas';
import { openContextMenu, MenuItem } from '../ContextMenu';
import { DND_MEDIA, DND_SFX_FILE } from '../MediaBin';
import { exportAudioForClips } from '../dialogs/ExportDialog';
import { Icon } from '../Icon';
import { ContextTip } from '../Hints';
import { TRANSITIONS as ALL_TRANSITIONS, transitionLabel, defaultTransitionDuration } from '../../../shared/transitions';

const RULER_H = 28;
const laneHeight = (t: Track) => (t.kind === 'text' ? 36 : t.kind === 'audio' ? 52 : 54);
const QUICK_TRANSITIONS: TransitionType[] = ['crossfade', 'dipBlack', 'flash', 'whipPan', 'zoomBlur', 'zoomPunch', 'slideLeft', 'pushLeft', 'wipeRight', 'iris', 'glitch', 'spin'];

interface Lane {
  track: Track;
  y: number;
  h: number;
}

function computeLanes(p: Project): { lanes: Lane[]; total: number } {
  let y = 0;
  const lanes = p.tracks.map((track) => {
    const h = laneHeight(track);
    const l = { track, y, h };
    y += h;
    return l;
  });
  return { lanes, total: y };
}

// --------------------------------------------------------------------------- clip view

interface ClipViewProps {
  clip: Clip;
  project: Project;
  track: Track;
  laneH: number;
  zoom: number;
  scrollX: number;
  viewW: number;
  selected: boolean;
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: DragMode) => void;
  onContext: (e: React.MouseEvent, clip: Clip) => void;
  /** preview-copy / waveform / thumbnail state of this clip's media (so the clip redraws when they change) */
  rtSig: string;
}

type DragMode = 'move' | 'trimL' | 'trimR' | 'fadeIn' | 'fadeOut' | 'volume' | 'volKey';

function clipKey(p: ClipViewProps): string {
  const m = p.clip.mediaId ? p.project.media[p.clip.mediaId] : undefined;
  return [
    p.rtSig,
    JSON.stringify(p.clip),
    p.track.muted,
    p.track.hidden,
    p.track.volume,
    p.laneH,
    p.zoom,
    p.scrollX.toFixed(4),
    p.viewW,
    p.selected,
    m?.missing,
  ].join('|');
}

const ClipView = React.memo(
  function ClipView(props: ClipViewProps) {
    const { clip: c, project, track, laneH, zoom, scrollX, viewW, selected } = props;
    const rt = getState().rt;
    const m = c.mediaId ? project.media[c.mediaId] : undefined;
    const left = (c.start - scrollX) * zoom;
    const width = Math.max(2, c.duration * zoom);
    const visLeft = Math.max(0, -left);
    const visRight = Math.min(width, viewW - left);
    const visW = Math.max(0, visRight - visLeft);
    const kind = c.kind;
    const hasAudio = kind === 'audio' || (kind === 'video' && !!m?.hasAudio && !c.audioDetached);
    const isAudioClip = kind === 'audio';
    const contentH = laneH - 4 - 16;
    const tags: string[] = [];
    if (c.speedKeys && c.speedKeys.length >= 2) tags.push('ramp');
    else if (Math.abs(c.speed - 1) > 1e-3) tags.push(`${+c.speed.toFixed(2)}×`);
    if (c.reversed) tags.push('reversed');
    if (c.linkId) tags.push('linked');
    if (c.muted) tags.push('muted');
    if (c.audioDetached) tags.push('audio split');
    if (c.color.look !== 'none') tags.push(c.color.look);
    if (c.shakes.length) tags.push('shake');
    const volY = (v: number) => 16 + contentH * (1 - clamp(v, 0, 2) / 2);
    const fadeInW = c.fadeIn * zoom;
    const fadeOutW = c.fadeOut * zoom;
    const label = kind === 'text' ? c.text?.text.split('\n')[0] || 'Text' : kind === 'adjust' ? c.name : c.name;
    const keys = c.volumeKeys && c.volumeKeys.length >= 2 ? c.volumeKeys : null;
    return (
      <div
        className={`clip ${kind}${selected ? ' sel' : ''}${c.muted || track.hidden ? ' muted' : ''}${m?.missing ? ' missing' : ''}`}
        style={{ left, width }}
        onPointerDown={(e) => props.onPointerDown(e, c, 'move')}
        onContextMenu={(e) => props.onContext(e, c)}
        data-clip={c.id}
      >
        <div className="clabel">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
          {tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
        {visW > 0 && (kind === 'video' || kind === 'image' || hasAudio) && (
          <ClipCanvas
            clip={c}
            media={m}
            project={project}
            proxy={m ? rt.proxies[m.id] : undefined}
            waveform={m ? rt.waveforms[m.path] : undefined}
            thumb={m ? rt.thumbs[m.id] : undefined}
            zoom={zoom}
            visLeft={visLeft}
            visWidth={visW}
            height={contentH}
            showStrip={kind === 'video' || kind === 'image'}
            showWave={hasAudio}
          />
        )}
        {kind === 'video' && m && !m.missing && (() => {
          const pr = rt.proxies[m.id];
          if (!pr || (pr.state !== 'queued' && pr.state !== 'running')) return null;
          return (
            <div className="clip-prep" style={{ left: visLeft }} title="This clip is still being prepared for smooth playback. You can keep editing; the preview gets sharp and smooth when it's done.">
              <span className="spin" />
              {pr.state === 'queued' ? 'Waiting…' : `Preparing ${Math.round(pr.progress * 100)}%`}
            </div>
          );
        })()}
        {c.transitionIn && (
          <div className="trans" style={{ width: Math.max(10, (c.transitionIn.duration / 2) * zoom) }} title={`${c.transitionIn.type} ${c.transitionIn.duration}s`}>
            {transitionLabel(c.transitionIn.type)}
          </div>
        )}
        {isAudioClip && (
          <>
            {/* fades */}
            <svg className="overlay" width={width} height={laneH - 4}>
              {fadeInW > 0 && <path d={`M0 ${laneH - 4} L${fadeInW} 16 L0 16 Z`} fill="rgba(0,0,0,0.35)" />}
              {fadeOutW > 0 && <path d={`M${width} ${laneH - 4} L${width - fadeOutW} 16 L${width} 16 Z`} fill="rgba(0,0,0,0.35)" />}
              {keys && (
                <polyline
                  points={[
                    `0,${volY(c.volume * evalKeys(keys, 0))}`,
                    ...keys.map((k) => `${k.t * zoom},${volY(c.volume * k.v)}`),
                    `${width},${volY(c.volume * evalKeys(keys, c.duration))}`,
                  ].join(' ')}
                  fill="none"
                  stroke="rgba(255,230,120,0.95)"
                  strokeWidth={1.5}
                />
              )}
            </svg>
            <div className="fade" style={{ left: Math.max(0, fadeInW - 5) }} title="Drag: fade in" onPointerDown={(e) => props.onPointerDown(e, c, 'fadeIn')} />
            <div className="fade" style={{ left: Math.min(width - 10, width - fadeOutW - 5) }} title="Drag: fade out" onPointerDown={(e) => props.onPointerDown(e, c, 'fadeOut')} />
            {!keys && (
              <div
                className="vol-line"
                style={{ top: volY(c.volume) }}
                title={`Volume ${(20 * Math.log10(Math.max(1e-4, c.volume))).toFixed(1)} dB — drag to change, Alt+click to add a keyframe`}
                onPointerDown={(e) => props.onPointerDown(e, c, 'volume')}
              />
            )}
            {keys &&
              keys.map((k, i) => (
                <div
                  key={i}
                  className="kf-dot"
                  style={{ left: k.t * zoom, top: volY(c.volume * k.v) }}
                  data-key={i}
                  title="Drag to move · double-click to delete"
                  onPointerDown={(e) => props.onPointerDown(e, c, 'volKey')}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    updateClips([c.id], (cc) => {
                      const ks = (cc.volumeKeys ?? []).filter((_, j) => j !== i);
                      cc.volumeKeys = ks.length >= 2 ? ks : undefined;
                    });
                  }}
                />
              ))}
            {keys && (
              <div
                className="vol-line"
                style={{ top: 16, height: contentH, marginTop: 0, opacity: 0 }}
                title="Alt+click to add a volume keyframe"
                onPointerDown={(e) => props.onPointerDown(e, c, 'volume')}
              />
            )}
          </>
        )}
        <div className="handle l" onPointerDown={(e) => props.onPointerDown(e, c, 'trimL')} />
        <div className="handle r" onPointerDown={(e) => props.onPointerDown(e, c, 'trimR')} />
      </div>
    );
  },
  (a, b) => clipKey(a) === clipKey(b),
);

// --------------------------------------------------------------------------- playhead

function PlayheadLine({ zoom, scrollX }: { zoom: number; scrollX: number }): React.ReactElement {
  const t = useStore((s) => s.ui.playhead);
  return <div className="playhead" style={{ left: (t - scrollX) * zoom }} />;
}

// --------------------------------------------------------------------------- main

interface DragState {
  mode: DragMode | 'scrub';
  clipId: string;
  startX: number;
  startY: number;
  moved: boolean;
  ids: string[];
  base: Project;
  points: number[];
  origStart: number;
  origEnd: number;
  laneIndex: number;
  keyIndex?: number;
  additive: boolean;
  pointerId: number;
}

export function Timeline(): React.ReactElement {
  const project = useStore((s) => s.project);
  const proxies = useStore((s) => s.rt.proxies);
  const waveforms = useStore((s) => s.rt.waveforms);
  const thumbs = useStore((s) => s.rt.thumbs);
  const mediaSig = (id?: string): string => {
    const m = id ? project.media[id] : undefined;
    if (!m) return '';
    const pr = proxies[m.id];
    return [pr?.state, pr ? Math.round(pr.progress * 20) : -1, pr?.stripUrl, !!waveforms[m.path], thumbs[m.id] ?? ''].join('~');
  };
  const zoom = useStore((s) => s.ui.zoom);
  const scrollX = useStore((s) => s.ui.scrollX);
  const selection = useStore((s) => s.ui.selection);
  const snapping = useStore((s) => s.ui.snapping);
  const snapLine = useStore((s) => s.ui.snapIndicator);
  const scrollEl = useRef<HTMLDivElement>(null);
  const lanesEl = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const [scrollTop, setScrollTop] = useState(0);
  const [dropLane, setDropLane] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const fps = project.settings.fps;
  const { lanes, total } = useMemo(() => computeLanes(project), [project.tracks]);
  const selSet = useMemo(() => new Set(selection), [selection]);

  useLayoutEffect(() => {
    const el = scrollEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // keep playhead in view while playing
  useEffect(() => {
    let last = 0;
    const id = setInterval(() => {
      const s = getState();
      if (!s.ui.playing) return;
      const x = (s.ui.playhead - s.ui.scrollX) * s.ui.zoom;
      if (x > viewW - 40 || x < 0) {
        const now = Date.now();
        if (now - last > 100) {
          last = now;
          setUI({ scrollX: Math.max(0, s.ui.playhead - 40 / s.ui.zoom) });
        }
      }
    }, 100);
    return () => clearInterval(id);
  }, [viewW]);

  const timeAt = useCallback((clientX: number) => {
    const r = scrollEl.current!.getBoundingClientRect();
    const s = getState().ui;
    return s.scrollX + (clientX - r.left) / s.zoom;
  }, []);

  const laneAt = useCallback(
    (clientY: number): Lane | null => {
      const el = lanesEl.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const y = clientY - r.top + el.scrollTop;
      const ls = computeLanes(getState().project).lanes;
      return ls.find((l) => y >= l.y && y < l.y + l.h) ?? null;
    },
    [],
  );

  // ------------------------------------------------------------------ pointer handling
  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: Clip, mode: DragMode) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const s = getState();
      const track = s.project.tracks.find((t) => t.id === clip.trackId);
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (mode === 'volume' && e.altKey) {
        // add a volume keyframe at the click position
        const local = clamp(timeAt(e.clientX) - clip.start, 0, clip.duration);
        updateClips([clip.id], (c) => {
          const cur = c.volumeKeys && c.volumeKeys.length >= 2 ? evalKeys(c.volumeKeys, local) : 1;
          const keys: Keyframe[] =
            c.volumeKeys && c.volumeKeys.length >= 2
              ? [...c.volumeKeys]
              : [
                  { t: 0, v: 1, ease: 'linear' },
                  { t: c.duration, v: 1, ease: 'linear' },
                ];
          keys.push({ t: local, v: cur, ease: 'linear' });
          c.volumeKeys = sortKeys(keys);
        });
        return;
      }
      if (!s.ui.selection.includes(clip.id) && !additive) select([clip.id]);
      else if (additive && mode === 'move') toggleSelect(clip.id);
      if (track?.locked) return;
      const ids = mode === 'move' ? withLinked(s.project, getState().ui.selection.includes(clip.id) ? getState().ui.selection : [clip.id]) : withLinked(s.project, [clip.id]);
      beginTx();
      const base = txBaseProject();
      const exclude = new Set(ids);
      const points = snapPoints(base, { playhead: s.ui.playhead, excludeIds: exclude, includeBeats: base.settings.snapToBeats || true });
      const laneIndex = computeLanes(base).lanes.findIndex((l) => l.track.id === clip.trackId);
      const target = e.target as HTMLElement;
      drag.current = {
        mode,
        clipId: clip.id,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        ids,
        base,
        points: base.settings.snapToBeats ? points : points.filter((t) => !base.markers.some((m) => m.kind === 'beat' && Math.abs(m.time - t) < EPS)),
        origStart: clip.start,
        origEnd: clipEnd(clip),
        laneIndex,
        keyIndex: target.dataset.key ? Number(target.dataset.key) : undefined,
        additive,
        pointerId: e.pointerId,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [timeAt],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const s = getState();
      const z = s.ui.zoom;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      d.moved = true;
      const thr = s.ui.snapping && !e.altKey ? 8 / z : 0;
      const f = d.base.settings.fps;
      if (d.mode === 'scrub') {
        setPlayhead(timeAt(e.clientX));
        return;
      }
      const base = d.base;
      const primary = base.clips[d.clipId];
      if (!primary) return;
      let snapAt: number | null = null;
      if (d.mode === 'move') {
        const dt = dx / z;
        let ns = Math.max(0, primary.start + dt);
        if (thr > 0) {
          const [s2, sp] = snapRange(ns, primary.duration, d.points, thr);
          ns = s2;
          snapAt = sp;
        }
        ns = snapFrame(Math.max(0, ns), f);
        const delta = ns - primary.start;
        // track change for the primary clip's kind
        const ls = computeLanes(base).lanes;
        const over = laneAt(e.clientY);
        const primTrack = base.tracks.find((t) => t.id === primary.trackId)!;
        const sameKind = ls.filter((l) => l.track.kind === primTrack.kind);
        const fromIdx = sameKind.findIndex((l) => l.track.id === primTrack.id);
        const toIdx = over && over.track.kind === primTrack.kind ? sameKind.findIndex((l) => l.track.id === over.track.id) : fromIdx;
        const tDelta = toIdx - fromIdx;
        const moves: ClipMove[] = d.ids
          .map((id) => base.clips[id])
          .filter(Boolean)
          .map((c) => {
            const tr = base.tracks.find((t) => t.id === c.trackId)!;
            let trackId = c.trackId;
            if (tDelta !== 0 && tr.kind === primTrack.kind) {
              const same = ls.filter((l) => l.track.kind === tr.kind);
              const i = same.findIndex((l) => l.track.id === tr.id);
              const ni = clamp(i + tDelta, 0, same.length - 1);
              if (!same[ni].track.locked) trackId = same[ni].track.id;
            }
            return { id: c.id, start: Math.max(0, c.start + delta), trackId };
          });
        updateTx((p) => moveClips(p, moves));
      } else if (d.mode === 'trimL' || d.mode === 'trimR') {
        let t = (d.mode === 'trimL' ? d.origStart : d.origEnd) + dx / z;
        if (thr > 0) {
          const [t2, sp] = snapTime(t, d.points, thr);
          t = t2;
          snapAt = sp;
        }
        t = snapFrame(t, f);
        updateTx((p) => {
          for (const id of d.ids) {
            const c = p.clips[id];
            if (!c) continue;
            const neighbors = clipsOnTrack(p, c.trackId).filter((o) => o.id !== c.id);
            if (d.mode === 'trimL') {
              const prevEnd = Math.max(0, ...neighbors.filter((o) => clipEnd(o) <= c.start + EPS).map(clipEnd));
              const delta = t - d.origStart;
              trimStartTo(p, c, Math.max(prevEnd, c.start + delta));
            } else {
              const nextStart = Math.min(Infinity, ...neighbors.filter((o) => o.start >= clipEnd(c) - EPS).map((o) => o.start));
              const delta = t - d.origEnd;
              trimEndTo(p, c, Math.min(nextStart, clipEnd(c) + delta));
            }
          }
        });
      } else if (d.mode === 'fadeIn' || d.mode === 'fadeOut') {
        const c0 = primary;
        updateTx((p) => {
          const c = p.clips[d.clipId];
          if (!c) return;
          if (d.mode === 'fadeIn') c.fadeIn = snapFrame(clamp(c0.fadeIn + dx / z, 0, c.duration / 2), f);
          else c.fadeOut = snapFrame(clamp(c0.fadeOut - dx / z, 0, c.duration / 2), f);
        });
      } else if (d.mode === 'volume') {
        const laneH = 52 - 4 - 16;
        const c0 = primary;
        const nv = clamp(c0.volume - (dy / laneH) * 2, 0, 2);
        updateTx((p) => {
          const c = p.clips[d.clipId];
          if (c) c.volume = Math.abs(nv - 1) < 0.03 ? 1 : nv;
        });
      } else if (d.mode === 'volKey' && d.keyIndex !== undefined) {
        const laneH = 52 - 4 - 16;
        const c0 = primary;
        const k0 = c0.volumeKeys![d.keyIndex];
        updateTx((p) => {
          const c = p.clips[d.clipId];
          if (!c || !c.volumeKeys) return;
          const ks = [...c.volumeKeys];
          const nt = clamp(k0.t + dx / z, 0, c.duration);
          const nv = clamp(k0.v - ((dy / laneH) * 2) / Math.max(0.05, c.volume), 0, 4);
          ks[d.keyIndex!] = { ...k0, t: nt, v: nv };
          c.volumeKeys = sortKeys(ks);
        });
      }
      if (getState().ui.snapIndicator !== snapAt) setUI({ snapIndicator: snapAt });
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      drag.current = null;
      setUI({ snapIndicator: null });
      if (d.mode === 'scrub') return;
      if (!d.moved) {
        cancelTx();
        if (d.mode === 'move' && !d.additive) select([d.clipId]);
        return;
      }
      endTx(true);
    };
    // window lost focus mid-drag (Alt+Tab, dialog): the pointerup never arrives, so finish the edit now
    const onBlur = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      setUI({ snapIndicator: null });
      if (d.mode === 'scrub') return;
      if (d.moved) endTx(true);
      else cancelTx();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [laneAt, timeAt]);

  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setUI({ playing: false });
    setPlayhead(timeAt(e.clientX));
    drag.current = {
      mode: 'scrub',
      clipId: '',
      startX: e.clientX,
      startY: e.clientY,
      moved: true,
      ids: [],
      base: getState().project,
      points: [],
      origStart: 0,
      origEnd: 0,
      laneIndex: 0,
      additive: false,
      pointerId: e.pointerId,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = getState().ui;
    if (e.ctrlKey || e.metaKey) {
      zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, timeAt(e.clientX));
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.shiftKey ? e.deltaY : e.deltaX) / s.zoom;
      setUI({ scrollX: Math.max(0, s.scrollX + d) });
    }
  };

  // ------------------------------------------------------------------ drop from bin / OS
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes(DND_MEDIA) || types.includes(DND_SFX_FILE) || types.includes('Files')) {
      e.preventDefault();
      const l = laneAt(e.clientY);
      setDropLane(l?.track.id ?? null);
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropLane(null);
    const lane = laneAt(e.clientY);
    const s = getState();
    let t = Math.max(0, timeAt(e.clientX));
    if (s.ui.snapping) {
      const pts = snapPoints(s.project, { playhead: s.ui.playhead, includeBeats: s.project.settings.snapToBeats });
      t = snapTime(t, pts, 10 / s.ui.zoom)[0];
    }
    const mediaId = e.dataTransfer.getData(DND_MEDIA);
    if (mediaId) {
      addMediaToTimeline(mediaId, lane?.track.id ?? null, t);
      return;
    }
    const sfx = e.dataTransfer.getData(DND_SFX_FILE);
    const paths = sfx ? [sfx] : Array.from(e.dataTransfer.files).map((f) => window.api.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const items = await importFiles(paths, sfx ? 'sfx' : undefined);
    let at = t;
    for (const m of items) {
      const id = addMediaToTimeline(m.id, lane?.track.id ?? null, at);
      const c = id ? getState().project.clips[id] : undefined;
      if (c) at = clipEnd(c);
    }
  };

  // ------------------------------------------------------------------ context menus
  const onClipContext = (e: React.MouseEvent, c: Clip) => {
    e.preventDefault();
    e.stopPropagation();
    if (!getState().ui.selection.includes(c.id)) select([c.id]);
    const p = getState().project;
    const m = c.mediaId ? p.media[c.mediaId] : undefined;
    const sel = getState().ui.selection;
    const items: MenuItem[] = [
      { header: c.name },
      { label: 'Split at playhead', shortcut: 'Ctrl+B', onClick: splitAtPlayhead },
      { label: 'Delete', shortcut: 'Del', onClick: () => deleteSelection(false) },
      { label: 'Ripple delete', shortcut: 'Shift+Del', onClick: () => deleteSelection(true) },
    ];
    if (c.kind === 'video') {
      items.push({ sep: true }, { header: 'Audio' });
      if (m?.hasAudio && !c.audioDetached) items.push({ label: 'Extract Audio', onClick: () => extractAudio(c.id) });
      if (c.audioDetached) items.push({ label: 'Re-attach audio', onClick: () => relinkAudioBack(c.id) });
    }
    if (c.linkId) items.push({ label: 'Unlink', onClick: () => unlink([c.id]) });
    if (c.kind === 'audio' || c.kind === 'video') {
      items.push({ label: c.muted ? 'Unmute clip' : 'Mute clip', onClick: () => updateClips(withLinked(p, [c.id]).filter((id) => p.clips[id]?.kind === c.kind), (cc) => (cc.muted = !cc.muted)) });
      items.push({ label: 'Export audio as MP3…', onClick: () => exportAudioForClips(sel, 'audio-mp3') });
      items.push({ label: 'Export audio as WAV…', onClick: () => exportAudioForClips(sel, 'audio-wav') });
    }
    if (c.kind === 'audio' && m?.hasAudio) {
      items.push({ label: m.beats ? `Re-detect beats (${m.bpm} BPM)` : 'Detect Beats', onClick: () => detectBeatsFor(c.id) });
    }
    if (c.kind === 'video' || c.kind === 'image') {
      items.push({ sep: true }, { header: 'Edit' });
      items.push({ label: 'Auto-cut to every beat', onClick: () => autoCut(c.id, 1) });
      items.push({ label: 'Auto-cut every 2nd beat', onClick: () => autoCut(c.id, 2) });
      items.push({ label: 'Auto-cut every 4th beat', onClick: () => autoCut(c.id, 4) });
      if (c.kind === 'video') {
        items.push({ label: 'Freeze frame at playhead', onClick: () => freezeFrame(c.id) });
        items.push({ label: c.reversed ? 'Un-reverse' : 'Reverse clip', onClick: () => reverseClip(c.id) });
      }
      items.push({ label: 'Punch-in zoom at playhead', onClick: () => punchIn(c.id) });
      items.push({ label: 'Camera shake at playhead', onClick: () => addShake(c.id) });
    }
    if (c.kind !== 'audio' && c.kind !== 'adjust') {
      items.push({ sep: true }, { header: 'Transition in' });
      for (const id of QUICK_TRANSITIONS) items.push({ label: (c.transitionIn?.type === id ? '• ' : '') + transitionLabel(id), onClick: () => setTransition(c.id, id, defaultTransitionDuration(id)) });
      items.push({ label: `All ${ALL_TRANSITIONS.length} transitions…`, onClick: () => { select([c.id]); setUI({ inspectorTab: 'effects' }); } });
      if (c.transitionIn) items.push({ label: 'Remove transition', onClick: () => setTransition(c.id, null) });
    }
    openContextMenu(e, items);
  };

  const onLaneContext = (e: React.MouseEvent, lane: Lane) => {
    e.preventDefault();
    const t = timeAt(e.clientX);
    openContextMenu(e, [
      { label: 'Add marker here', onClick: () => commit((p) => void p.markers.push({ id: uid('mrk_'), time: snapFrame(t, p.settings.fps), label: 'Marker', color: '#ffb020', kind: 'user' })) },
      { label: 'Add text here', onClick: () => { setPlayhead(t); addTextClip(); } },
      { label: 'Add letterbox (2.39:1) here', onClick: () => { setPlayhead(t); addLetterboxClip(); } },
      { sep: true },
      { label: `Add ${lane.track.kind} track`, onClick: () => commit((p) => void addTrack(p, lane.track.kind)) },
      { label: `Delete track ${lane.track.name}`, onClick: () => commit((p) => removeTrack(p, lane.track.id)), disabled: project.tracks.filter((x) => x.kind === lane.track.kind).length <= 1 },
    ]);
  };

  const hasClips = Object.keys(project.clips).length > 0;
  const markers = project.markers;
  const vis = (t: number) => (t - scrollX) * zoom;

  return (
    <div className="timeline" data-tour="timeline">
      <div className="tl-toolbar">
        <button className="ghost small" title="Cut the selected clip (or everything) at the red playhead (C)" onClick={splitAtPlayhead}>
          <Icon name="scissors" size={15} /> Split
        </button>
        <button className="ghost small" title="Delete the selected clips (Delete)" onClick={() => deleteSelection(false)} disabled={!selection.length}>
          <Icon name="trash" size={15} /> Delete
        </button>
        <button className="ghost small" title="Delete and close the gap so later clips slide left (Shift+Delete)" onClick={() => deleteSelection(true)}>
          <Icon name="ripple" size={15} /> Ripple
        </button>
        <span className="sep-v" />
        <button className="ghost small" title="Drop a marker at the playhead (M)" onClick={addMarkerAtPlayhead}>
          <Icon name="marker" size={14} /> Marker
        </button>
        <button className="ghost small" title="Add a text title at the playhead (T)" onClick={() => addTextClip()}>
          <Icon name="text" size={15} /> Text
        </button>
        <button className="ghost small" title="Add cinematic 2.39:1 black bars for a section" onClick={addLetterboxClip}>
          <Icon name="letterbox" size={15} /> Letterbox
        </button>
        <ContextTip />
        <button className={'ghost small' + (snapping ? ' on' : '')} title="Snapping: clips stick to the playhead, other clips and markers (S). Hold Alt while dragging to turn it off." onClick={() => setUI({ snapping: !snapping })}>
          <Icon name="magnet" size={15} /> Snap
        </button>
        <button
          className={'ghost small' + (project.settings.snapToBeats ? ' on' : '')}
          title="Make cuts snap to the beats of your music (detect beats first: right-click the music clip)"
          onClick={() => commit((p) => void (p.settings.snapToBeats = !p.settings.snapToBeats))}
        >
          <Icon name="beat" size={15} /> Beats
        </button>
        <span className="sep-v" />
        <button className="ghost icon" title="Zoom out (-)" onClick={() => zoomBy(1 / 1.4)}>
          <Icon name="minus" size={15} />
        </button>
        <input type="range" min={Math.log(2)} max={Math.log(2400)} step={0.01} value={Math.log(zoom)} onChange={(e) => setUI({ zoom: Math.exp(Number(e.target.value)) })} style={{ width: 110 }} />
        <button className="ghost icon" title="Zoom in (+)" onClick={() => zoomBy(1.4)}>
          <Icon name="plus" size={15} />
        </button>
        <button className="ghost icon" title="Zoom to fit the whole trailer (Shift+Z)" onClick={() => zoomToFit(viewW)}>
          <Icon name="fit" size={15} />
        </button>
      </div>
      <div className="tl-body">
        <div className="tl-heads">
          <div className="tl-ruler-spacer">
            <span className="hint" style={{ flex: 1 }}>Tracks</span>
            <button className="ghost small" title="Add a video track" onClick={() => commit((p) => void addTrack(p, 'video'))}>
              +V
            </button>
            <button className="ghost small" title="Add an audio track" onClick={() => commit((p) => void addTrack(p, 'audio'))}>
              +A
            </button>
            <button className="ghost small" title="Add a text track" onClick={() => commit((p) => void addTrack(p, 'text'))}>
              +T
            </button>
          </div>
          <div style={{ position: 'absolute', top: RULER_H, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
            <div className="tl-heads-inner" style={{ top: -scrollTop }}>
              {lanes.map((l) => (
                <TrackHead key={l.track.id} lane={l} />
              ))}
            </div>
          </div>
        </div>
        <div className="tl-scroll" ref={scrollEl} onWheel={onWheel}>
          <div className="tl-ruler" onPointerDown={startScrub}>
            <Ruler width={viewW} zoom={zoom} scrollX={scrollX} fps={fps} />
            {project.inPoint !== undefined && (
              <div
                className="inout"
                style={{ left: vis(project.inPoint), width: Math.max(2, (project.outPoint ?? project.inPoint + 0.1) * zoom - project.inPoint * zoom) }}
              />
            )}
            {markers.map((m) =>
              vis(m.time) < -10 || vis(m.time) > viewW + 10 ? null : (
                <div
                  key={m.id}
                  className={'marker' + (m.kind === 'beat' ? ' beat' : '')}
                  style={{ left: vis(m.time), background: m.color }}
                  title={`${m.label} — ${m.time.toFixed(2)}s (right-click to delete)`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setPlayhead(m.time);
                  }}
                  onContextMenu={(e) =>
                    openContextMenu(e, [
                      { header: m.label },
                      { label: 'Delete marker', onClick: () => commit((p) => void (p.markers = p.markers.filter((x) => x.id !== m.id))) },
                      ...(m.kind === 'beat' ? [{ label: 'Delete all beat markers', onClick: () => commit((p) => void (p.markers = p.markers.filter((x) => x.kind !== 'beat'))) }] : []),
                      { label: 'Delete all user markers', onClick: () => commit((p) => void (p.markers = p.markers.filter((x) => x.kind !== 'user'))) },
                    ])
                  }
                />
              ),
            )}
          </div>
          <div
            className="tl-lanes"
            ref={lanesEl}
            style={{ overflowY: 'auto' }}
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            onDragOver={onDragOver}
            onDragLeave={() => setDropLane(null)}
            onDrop={onDrop}
          >
            <div className="tl-lanes-inner" style={{ height: total }}>
              {lanes.map((l) => (
                <div
                  key={l.track.id}
                  className={`lane ${l.track.kind}${l.track.locked ? ' locked' : ''}${dropLane === l.track.id ? ' drop' : ''}`}
                  style={{ height: l.h }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    if (!(e.shiftKey || e.ctrlKey)) setUI({ selection: [] });
                    startScrub(e);
                  }}
                  onContextMenu={(e) => onLaneContext(e, l)}
                >
                  {clipsOnTrack(project, l.track.id).map((c) => {
                    const left = (c.start - scrollX) * zoom;
                    if (left > viewW + 50 || left + c.duration * zoom < -50) return null;
                    return (
                      <ClipView
                        key={c.id}
                        clip={c}
                        project={project}
                        track={l.track}
                        laneH={l.h}
                        zoom={zoom}
                        scrollX={scrollX}
                        viewW={viewW}
                        selected={selSet.has(c.id)}
                        onPointerDown={onClipPointerDown}
                        onContext={onClipContext}
                        rtSig={mediaSig(c.mediaId)}
                      />
                    );
                  })}
                </div>
              ))}
              {markers
                .filter((m) => m.kind !== 'beat' || project.settings.snapToBeats)
                .map((m) => (
                  <div key={m.id} className="marker-line" style={{ left: vis(m.time), background: m.color }} />
                ))}
            </div>
          </div>
          <PlayheadLine zoom={zoom} scrollX={scrollX} />
          {snapLine !== null && <div className="snapline" style={{ left: vis(snapLine) }} />}
          {!hasClips && (
            <div className="welcome" style={{ top: 40 }}>
              <div className="hint" style={{ fontSize: 13 }}>
                Drag clips from the Media Bin here. Right-click clips for audio, beat and effect tools.
              </div>
            </div>
          )}
        </div>
      </div>
      <HScroll viewW={viewW} />
    </div>
  );
}

function HScroll({ viewW }: { viewW: number }): React.ReactElement {
  const zoom = useStore((s) => s.ui.zoom);
  const scrollX = useStore((s) => s.ui.scrollX);
  const dur = useStore((s) => {
    let d = 0;
    for (const c of Object.values(s.project.clips)) d = Math.max(d, c.start + c.duration);
    return d;
  });
  const total = Math.max(dur + 30, scrollX + viewW / zoom);
  const w = Math.max(30, ((viewW / zoom) / total) * viewW);
  const x = (scrollX / total) * viewW;
  const ref = useRef<{ x0: number; s0: number } | null>(null);
  return (
    <div className="tl-hscroll" style={{ marginLeft: 170 }}>
      <div
        className="thumb"
        style={{ left: x, width: w }}
        onPointerDown={(e) => {
          ref.current = { x0: e.clientX, s0: scrollX };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!ref.current) return;
          const dx = e.clientX - ref.current.x0;
          setUI({ scrollX: Math.max(0, ref.current.s0 + (dx / viewW) * total) });
        }}
        onPointerUp={() => (ref.current = null)}
      />
    </div>
  );
}

function TrackHead({ lane }: { lane: Lane }): React.ReactElement {
  const t = lane.track;
  const set = (fn: (tr: Track) => void) =>
    commit((p) => {
      const tr = p.tracks.find((x) => x.id === t.id);
      if (tr) fn(tr);
    });
  return (
    <div className="track-head" style={{ height: lane.h }}>
      <span className={`tname ${t.kind}`} title={t.name}>
        {t.name}
      </span>
      {t.kind === 'audio' && (
        <select value={t.role} onChange={(e) => set((tr) => (tr.role = e.target.value as Track['role']))} title="Track role (used for auto-ducking)">
          <option value="game">Game</option>
          <option value="music">Music</option>
          <option value="sfx">SFX</option>
          <option value="voice">Voice</option>
        </select>
      )}
      {t.kind !== 'audio' && (
        <button className={'ghost' + (t.hidden ? ' on' : '')} title={t.hidden ? 'Show track' : 'Hide track'} onClick={() => set((tr) => (tr.hidden = !tr.hidden))}>
          <Icon name={t.hidden ? 'eyeOff' : 'eye'} />
        </button>
      )}
      {t.kind !== 'text' && (
        <button className={'ghost' + (t.muted ? ' on' : '')} title={t.muted ? 'Unmute track' : 'Mute track'} onClick={() => set((tr) => (tr.muted = !tr.muted))}>
          <Icon name={t.muted ? 'mute' : 'volume'} />
        </button>
      )}
      <button className={'ghost' + (t.locked ? ' on' : '')} title={t.locked ? 'Unlock track' : 'Lock track (prevents edits)'} onClick={() => set((tr) => (tr.locked = !tr.locked))}>
        <Icon name={t.locked ? 'lock' : 'unlock'} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ quick effects used from menus

export function punchIn(clipId: string): void {
  const s = getState();
  const c = s.project.clips[clipId];
  if (!c) return;
  const f = s.project.settings.fps;
  const local = clamp(snapFrame(s.ui.playhead - c.start, f), 0, c.duration);
  const base = c.transform.scale.keys && c.transform.scale.keys.length >= 2 ? evalKeys(c.transform.scale.keys, local) : c.transform.scale.value;
  updateClips([clipId], (cc) => {
    const keys = (cc.transform.scale.keys ?? []).filter((k) => k.t < local - 1e-3 || k.t > local + 0.5);
    keys.push({ t: Math.max(0, local - 1 / f), v: base, ease: 'easeOut' });
    keys.push({ t: Math.min(cc.duration, local + 0.12), v: base * 1.25, ease: 'easeInOut' });
    keys.push({ t: Math.min(cc.duration, local + 0.45), v: base * 1.12, ease: 'linear' });
    cc.transform.scale = { value: cc.transform.scale.value, keys: sortKeys(keys) };
  });
  toast('Punch-in zoom added (edit it in Inspector → Transform)', 'success', 2000);
}

export function addShake(clipId: string, intensity = 0.6, duration = 0.5): void {
  const s = getState();
  const c = s.project.clips[clipId];
  if (!c) return;
  const local = clamp(s.ui.playhead - c.start, 0, c.duration - 0.05);
  updateClips([clipId], (cc) => {
    cc.shakes = [...cc.shakes, { at: local, duration: Math.min(duration, cc.duration - local), intensity, frequency: 9 }];
  });
  toast('Camera shake added (adjust in Inspector → Effects)', 'success', 2000);
}

export { MIN_CLIP, maxDuration };
