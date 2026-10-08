// Preview playback engine: master clock, <video>/<audio> element sync (proxies), WebAudio mixing,
// WebGL compositing and a small cache of rendered frames for instant re-scrubbing.
import { getState, setUI, subscribe } from '../store/store';
import type { Clip, MediaItem, Project } from '../../shared/types';
import { layersAt, LayerState, sourceTimeClamped, clipHasAudio, contentSize } from '../../shared/evaluate';
import { buildClipLut, colorSig, isNeutralColor, parseCube, vignetteAngle, CubeLut } from '../../shared/color';
import { clipGainAt } from '../../shared/render/buildGraph';
import { speedAt } from '../../shared/keyframes';
import { clipEnd, projectDuration } from '../../shared/timelineOps';
import { computeDuckIntervals, duckGainAt, DuckInterval } from '../../shared/ducking';
import { GLCompositor } from './glCompositor';
import { drawText, textIsAnimated } from './textRender';
import { clamp } from '../../shared/time';

interface MediaEl {
  el: HTMLMediaElement;
  url: string;
  clipId: string;
  gain: GainNode | null;
  pendingSeek: number | null;
  queuedSeek: number | null;
  lastUsed: number;
}

const PLAYABLE_ORIGINAL = /\.(mp4|m4v|webm|mov)$/i;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export class PreviewEngine {
  private gl: GLCompositor;
  private raf = 0;
  private running = false;
  private videos = new Map<string, MediaEl>(); // key: clipId (visual)
  private audios = new Map<string, MediaEl>(); // key: clipId (audio-only clips)
  private images = new Map<string, HTMLImageElement>();
  private textCanvases = new Map<string, { canvas: HTMLCanvasElement; key: string }>();
  private onFonts = () => {
    this.textCanvases.clear();
    this.clearFrameCache();
    this.dirty = true;
  };
  private lutCache = new Map<string, Float32Array>();
  private userLuts = new Map<string, CubeLut | 'loading' | 'error'>();
  private audioCtx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wallStart = 0;
  private tStart = 0;
  private lastPlayhead = -1;
  private clockRate = 1;
  private lastRendered = '';
  private dirty = true;
  private frameCache = new Map<string, ImageBitmap>();
  /** set while drawing a frame whose user LUT is still loading (frame must not be cached) */
  private lutPending = false;
  private duck: { rev: number; intervals: DuckInterval[] } = { rev: -1, intervals: [] };
  private unsub: () => void;
  private overlay: CanvasRenderingContext2D | null;
  private tick = 0;
  /** status text drawn on the overlay (e.g. "Generating proxy…") */
  private notes: string[] = [];

  constructor(private canvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement) {
    this.gl = new GLCompositor(canvas);
    this.overlay = overlayCanvas.getContext('2d');
    window.addEventListener('islandcut-fonts-loaded', this.onFonts);
    this.unsub = subscribe(() => {
      this.dirty = true;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.unsub();
    window.removeEventListener('islandcut-fonts-loaded', this.onFonts);
    for (const m of [...this.videos.values(), ...this.audios.values()]) this.disposeEl(m);
    this.videos.clear();
    this.audios.clear();
    for (const b of this.frameCache.values()) b.close();
    this.frameCache.clear();
    this.audioCtx?.close();
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const p = getState().project;
    const scale = Math.min(1, (cssH * dpr) / p.settings.height, (cssW * dpr) / p.settings.width);
    const w = Math.max(2, Math.round(p.settings.width * scale));
    const h = Math.max(2, Math.round(p.settings.height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      const oc = this.overlay?.canvas;
      if (oc) {
        oc.width = w;
        oc.height = h;
      }
      this.clearFrameCache();
      this.dirty = true;
    }
  }

  clearFrameCache(): void {
    for (const b of this.frameCache.values()) b.close();
    this.frameCache.clear();
  }

  // ---------------------------------------------------------------- audio
  private ensureAudio(): void {
    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => undefined);
      return;
    }
    try {
      this.audioCtx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.audioCtx.createGain();
      this.master.connect(this.audioCtx.destination);
    } catch {
      this.audioCtx = null;
    }
  }

  private connectAudio(m: MediaEl): void {
    if (m.gain || !this.audioCtx || !this.master) return;
    try {
      const src = this.audioCtx.createMediaElementSource(m.el);
      m.gain = this.audioCtx.createGain();
      m.gain.gain.value = 0;
      src.connect(m.gain);
      m.gain.connect(this.master);
      // Chromium applies the element's own volume before WebAudio: an element that was created
      // (paused, volume 0) before the first Play would otherwise stay silent forever
      m.el.volume = 1;
    } catch {
      /* already connected */
    }
  }

  // ---------------------------------------------------------------- sources
  /** original files the browser could not decode (e.g. some HEVC/ProRes): use the preview copy instead */
  private badOriginals = new Set<string>();

  private urlFor(p: Project, m: MediaItem, forAudioOnly: boolean): string | null {
    const rt = getState().rt;
    if (m.kind === 'audio') return window.api.mediaUrl(m.path);
    const original = window.api.mediaUrl(m.path);
    const playable = PLAYABLE_ORIGINAL.test(m.path) && !this.badOriginals.has(original);
    // "Original": the file itself at full resolution (sharpest, heaviest)
    if ((rt.settings?.previewQuality ?? 'high') === 'original' && playable) return original;
    // otherwise the preview copy (1080p "High" or 540p "Smooth"); the original until it's ready
    const proxy = rt.proxies[m.id];
    if (proxy?.state === 'ready' && proxy.proxyUrl) return proxy.proxyUrl;
    if (playable) return original;
    void p;
    void forAudioOnly;
    return null;
  }

  private makeEl(kind: 'video' | 'audio', url: string, clipId: string): MediaEl {
    const el = document.createElement(kind);
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.disablePictureInPicture = true;
    }
    el.src = url;
    const m: MediaEl = { el, url, clipId, gain: null, pendingSeek: null, queuedSeek: null, lastUsed: performance.now() };
    el.addEventListener('seeked', () => {
      m.pendingSeek = null;
      if (m.queuedSeek !== null) {
        const q = m.queuedSeek;
        m.queuedSeek = null;
        this.seek(m, q);
      }
      this.dirty = true;
    });
    el.addEventListener('loadeddata', () => (this.dirty = true));
    el.addEventListener('error', () => {
      if (url.startsWith('media://') && !url.includes('proxies')) this.badOriginals.add(url);
      this.dirty = true;
    });
    if (this.audioCtx) this.connectAudio(m);
    return m;
  }

  private disposeEl(m: MediaEl): void {
    try {
      m.el.pause();
      m.gain?.disconnect();
      m.el.removeAttribute('src');
      m.el.load();
    } catch {
      /* ignore */
    }
  }

  private seek(m: MediaEl, t: number): void {
    if (m.pendingSeek !== null) {
      m.queuedSeek = t;
      return;
    }
    m.pendingSeek = t;
    try {
      m.el.currentTime = Math.max(0, t);
    } catch {
      m.pendingSeek = null;
    }
  }

  private getEl(map: Map<string, MediaEl>, kind: 'video' | 'audio', clipId: string, url: string): MediaEl {
    let m = map.get(clipId);
    if (m && m.url !== url) {
      this.disposeEl(m);
      map.delete(clipId);
      m = undefined;
    }
    if (!m) {
      m = this.makeEl(kind, url, clipId);
      map.set(clipId, m);
    }
    m.lastUsed = performance.now();
    return m;
  }

  // ---------------------------------------------------------------- color
  private lutFor(c: Clip): { data: Float32Array | null; key: string } {
    if (c.kind === 'text' || isNeutralColor(c.color)) return { data: null, key: '' };
    let user: CubeLut | null = null;
    if (c.color.lutPath) {
      const u = this.userLuts.get(c.color.lutPath);
      if (!u) {
        this.userLuts.set(c.color.lutPath, 'loading');
        window.api
          .readText(c.color.lutPath)
          .then((txt) => {
            this.userLuts.set(c.color.lutPath!, parseCube(txt));
            this.lutCache.clear();
            this.clearFrameCache(); // frames cached before the LUT arrived are wrong
            this.dirty = true;
          })
          .catch(() => this.userLuts.set(c.color.lutPath!, 'error'));
      } else if (typeof u === 'object') user = u;
      if (!user && this.userLuts.get(c.color.lutPath) === 'loading') this.lutPending = true;
    }
    const key = colorSig(c.color) + (user ? '|u' : '');
    let data = this.lutCache.get(key);
    if (!data) {
      data = buildClipLut(c.color, user);
      if (this.lutCache.size > 64) this.lutCache.clear();
      this.lutCache.set(key, data);
    }
    return { data, key };
  }

  // ---------------------------------------------------------------- main loop
  private frame(now: number): void {
    const s = getState();
    const p = s.project;
    const fps = p.settings.fps;
    const dur = projectDuration(p);
    let t = s.ui.playhead;
    const playing = s.ui.playing;
    if (playing) {
      this.ensureAudio();
      const rate = s.ui.rate;
      if (this.lastPlayhead < 0 || Math.abs(t - this.lastPlayhead) > 1e-6 || rate !== this.clockRate) {
        // playhead moved externally (scrub while playing), playback just started, or the
        // shuttle speed changed (J/L): restart the clock from the current position
        this.wallStart = now;
        this.tStart = t;
        this.clockRate = rate;
      }
      t = this.tStart + ((now - this.wallStart) / 1000) * rate;
      const end = p.outPoint !== undefined && p.outPoint > (p.inPoint ?? 0) ? p.outPoint : dur;
      if (t >= end || t < 0) {
        t = clamp(t, 0, end);
        setUI({ playing: false, rate: 1, playhead: t });
        this.lastPlayhead = t;
      } else {
        this.lastPlayhead = t;
        setUI({ playhead: t });
      }
      this.dirty = true;
    } else {
      this.lastPlayhead = -1;
    }

    this.syncMedia(p, t, playing, s.ui.rate);
    if (++this.tick % 120 === 0) this.gc();
    const frameIdx = Math.round(t * fps);
    const key = `${s.ui.revision}|${frameIdx}|${this.canvas.width}x${this.canvas.height}|${JSON.stringify(s.rt.proxies).length}`;
    if (!this.dirty && key === this.lastRendered) return;
    this.dirty = false;
    this.render(p, t, playing, key);
    this.lastRendered = key;
  }

  private syncMedia(p: Project, t: number, playing: boolean, rate: number): void {
    const fps = p.settings.fps;
    const needVideo = new Set<string>();
    const needAudio = new Set<string>();
    const reverse = playing && rate < 0;
    const normalPlay = playing && rate > 0;
    const look = playing ? 1.2 : 0.3;
    if (this.duck.rev !== getState().ui.revision) {
      this.duck = { rev: getState().ui.revision, intervals: p.settings.duckingEnabled ? computeDuckIntervals(p, getState().rt.waveforms) : [] };
    }
    const tracks = new Map(p.tracks.map((tr) => [tr.id, tr]));
    for (const c of Object.values(p.clips)) {
      const tr = tracks.get(c.trackId);
      if (!tr) continue;
      const m = c.mediaId ? p.media[c.mediaId] : undefined;
      if (!m || m.missing) continue;
      const active = t >= c.start - 0.6 && t < clipEnd(c) + 0.6;
      const soon = t >= c.start - look && t < clipEnd(c);
      if (!active && !soon) continue;
      const local = t - c.start;
      const inside = t >= c.start && t < clipEnd(c);
      if (c.kind === 'video' && !(tr.hidden && (c.audioDetached || c.muted || tr.muted))) {
        const url = this.urlFor(p, m, false);
        if (!url) continue;
        const el = this.getEl(this.videos, 'video', c.id, url);
        needVideo.add(c.id);
        const desired = sourceTimeClamped(p, c, Math.max(local, -0.5));
        const audible = clipHasAudio(p, c) && !c.muted && !tr.muted && inside && normalPlay;
        this.syncEl(el, desired, inside || local < 0, playing, rate, speedAt(c, clamp(local, 0, c.duration)), fps);
        this.setGain(el, audible ? clipGainAt(p, c, local) * (tr.role === 'music' ? duckGainAt(p, this.duck.intervals, t) : 1) : 0);
      } else if (c.kind === 'audio') {
        const url = this.urlFor(p, m, true);
        if (!url) continue;
        const el = this.getEl(this.audios, 'audio', c.id, url);
        needAudio.add(c.id);
        const desired = sourceTimeClamped(p, c, Math.max(local, 0));
        const audible = !c.muted && !tr.muted && inside && normalPlay;
        this.syncEl(el, desired, inside, normalPlay, rate, speedAt(c, clamp(local, 0, c.duration)), fps, true);
        this.setGain(el, audible ? clipGainAt(p, c, local) * (tr.role === 'music' ? duckGainAt(p, this.duck.intervals, t) : 1) : 0);
      }
    }
    void reverse;
    for (const [id, m] of this.videos) if (!needVideo.has(id)) {
      m.el.pause();
      if (performance.now() - m.lastUsed > 4000) {
        this.disposeEl(m);
        this.videos.delete(id);
      }
    }
    for (const [id, m] of this.audios) if (!needAudio.has(id)) {
      m.el.pause();
      if (performance.now() - m.lastUsed > 4000) {
        this.disposeEl(m);
        this.audios.delete(id);
      }
    }
  }

  private setGain(m: MediaEl, g: number): void {
    if (this.audioCtx && !m.gain) this.connectAudio(m);
    if (m.gain && this.audioCtx) m.gain.gain.setTargetAtTime(g, this.audioCtx.currentTime, 0.015);
    else m.el.volume = clamp(g, 0, 1);
  }

  private syncEl(m: MediaEl, desired: number, inside: boolean, playing: boolean, rate: number, speed: number, fps: number, audioOnly = false): void {
    const el = m.el;
    const effRate = rate * speed;
    if (playing && rate > 0 && inside && effRate >= 0.0625 && effRate <= 16) {
      if (Math.abs(el.playbackRate - effRate) > 0.01) el.playbackRate = effRate;
      const drift = el.currentTime - desired;
      if (el.paused) {
        if (Math.abs(drift) > 0.05) this.seek(m, desired);
        el.play().catch(() => undefined);
      } else if (Math.abs(drift) > (audioOnly ? 0.12 : 0.15)) {
        this.seek(m, desired + 0.03 * effRate);
      }
      return;
    }
    if (!el.paused) el.pause();
    if (audioOnly && !inside) return;
    if (Math.abs(el.currentTime - desired) > 0.4 / fps && (m.pendingSeek === null || Math.abs(m.pendingSeek - desired) > 0.4 / fps)) {
      this.seek(m, desired + 0.25 / fps);
    }
  }

  private gc(): void {
    this.gl.gc();
    const now = performance.now();
    for (const [id, tc] of this.textCanvases) {
      if (!getState().project.clips[id]) this.textCanvases.delete(id);
      void tc;
    }
    void now;
  }

  // ---------------------------------------------------------------- rendering
  private render(p: Project, t: number, playing: boolean, cacheKey: string): void {
    const gl = this.gl;
    gl.projectW = p.settings.width;
    gl.projectH = p.settings.height;
    const cached = !playing ? this.frameCache.get(cacheKey) : undefined;
    this.notes = [];
    const bg = hexToRgb(p.settings.backgroundColor);
    gl.begin(bg);
    if (cached) {
      gl.draw(
        {
          layer: fullFrameLayer(p),
          source: cached,
          sourceKey: '__cache__' + cacheKey,
          contentW: p.settings.width,
          contentH: p.settings.height,
          lut: null,
          lutKey: '',
          vignette: 0,
          seed: 0,
        },
        true,
      );
      this.gl.invalidateTexture('__cache__' + cacheKey);
      this.drawOverlay(p);
      return;
    }
    const layers = layersAt(p, t);
    let complete = true;
    this.lutPending = false;
    for (const L of layers) {
      const c = L.clip;
      if (c.kind === 'adjust') {
        if (c.adjust?.letterbox) {
          const W = p.settings.width;
          const H = p.settings.height;
          const bar = Math.max(0, (H - W / (c.adjust.letterboxRatio || 2.39)) / 2);
          if (bar > 0) {
            gl.rect(0, 0, W, bar, [0, 0, 0, 1]);
            gl.rect(0, H - bar, W, bar, [0, 0, 0, 1]);
          }
        }
        continue;
      }
      const ok = this.drawLayer(p, L);
      if (!ok) complete = false;
    }
    this.drawOverlay(p);
    // Cache fully-rendered paused frames (effects included) for instant re-scrubbing.
    if (this.lutPending) complete = false;
    if (!playing && complete && layers.length) {
      const canvas = this.canvas;
      // memory budget ~300 MB of cached frames, whatever the preview size
      const maxFrames = Math.max(8, Math.min(90, Math.floor(300e6 / Math.max(1, canvas.width * canvas.height * 4))));
      createImageBitmap(canvas)
        .then((bmp) => {
          while (this.frameCache.size >= maxFrames) {
            const first = this.frameCache.keys().next().value as string;
            this.frameCache.get(first)?.close();
            this.frameCache.delete(first);
          }
          this.frameCache.set(cacheKey, bmp);
        })
        .catch(() => undefined);
    }
  }

  private drawLayer(p: Project, L: LayerState): boolean {
    const c = L.clip;
    const fps = p.settings.fps;
    const lut = this.lutFor(c);
    const vign = c.kind === 'text' ? 0 : c.color.vignette > 0.001 ? vignetteAngle(c.color.vignette) : 0;
    const seed = Math.round((p.settings.fps * (c.start + L.local)) % 997) / 997;
    const { w: cw, h: ch } = contentSize(p, c);
    if (c.kind === 'video') {
      const m = this.videos.get(c.id);
      if (!m) {
        const media = c.mediaId ? p.media[c.mediaId] : undefined;
        if (media?.missing) this.notes.push(`Missing media: ${media.name}`);
        else {
          const pr = media ? getState().rt.proxies[media.id] : undefined;
          this.notes.push(pr?.state === 'running' ? `Preparing “${media?.name}” for preview… ${Math.round(pr.progress * 100)}%` : pr?.state === 'error' ? `Can't preview “${media?.name}” (it still exports fine)` : `Preparing “${media?.name ?? 'clip'}” for preview…`);
        }
        return false;
      }
      const v = m.el as HTMLVideoElement;
      if (v.readyState >= 2 && v.videoWidth === 0 && !m.url.includes('proxies')) {
        // the browser plays only the sound of this file (codec it can't show): switch to the preview copy
        this.badOriginals.add(m.url);
        this.dirty = true;
      }
      if (v.readyState < 2 || v.videoWidth === 0) return false;
      this.gl.draw({ layer: L, source: v, sourceKey: 'v:' + c.id, contentW: cw, contentH: ch, lut: lut.data, lutKey: lut.key, vignette: vign, seed, fill: c.cleanup }, true);
      return m.pendingSeek === null;
    }
    if (c.kind === 'image') {
      const media = c.mediaId ? p.media[c.mediaId] : undefined;
      if (!media) return true;
      let img = this.images.get(media.id);
      if (!img) {
        img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => (this.dirty = true);
        img.src = window.api.mediaUrl(media.path);
        this.images.set(media.id, img);
      }
      if (!img.complete || img.naturalWidth === 0) return false;
      this.gl.draw({ layer: L, source: img, sourceKey: 'i:' + media.id, contentW: cw, contentH: ch, lut: lut.data, lutKey: lut.key, vignette: vign, seed }, false);
      return true;
    }
    if (c.kind === 'text' && c.text) {
      const H = this.canvas.height;
      const W = Math.round((H * p.settings.width) / p.settings.height);
      const animated = textIsAnimated(c.text);
      const local = clamp(L.local, 0, c.duration);
      const key = JSON.stringify(c.text) + `|${W}x${H}|${c.duration}|` + (animated ? Math.round(local * fps) : 'static');
      let tc = this.textCanvases.get(c.id);
      if (!tc) {
        const canvas = document.createElement('canvas');
        tc = { canvas, key: '' };
        this.textCanvases.set(c.id, tc);
      }
      let dyn = false;
      if (tc.key !== key) {
        tc.canvas.width = W;
        tc.canvas.height = H;
        const ctx = tc.canvas.getContext('2d', { willReadFrequently: true })!;
        drawText(ctx, W, H, c.text, local, c.duration, fps, p.settings.height);
        tc.key = key;
        dyn = true;
      }
      this.gl.draw({ layer: L, source: tc.canvas, sourceKey: 't:' + c.id, contentW: W, contentH: H, lut: null, lutKey: '', vignette: 0, seed }, dyn);
      return true;
    }
    return true;
  }

  private drawOverlay(p: Project): void {
    const o = this.overlay;
    if (!o) return;
    const s = getState();
    const W = o.canvas.width;
    const H = o.canvas.height;
    o.clearRect(0, 0, W, H);
    if (s.ui.showLetterboxGuide) {
      const bar = Math.max(0, (H - W / 2.39) / 2);
      o.fillStyle = 'rgba(0,0,0,0.55)';
      o.fillRect(0, 0, W, bar);
      o.fillRect(0, H - bar, W, bar);
      o.strokeStyle = 'rgba(255,200,0,0.6)';
      o.lineWidth = 1;
      o.strokeRect(0.5, bar + 0.5, W - 1, H - 2 * bar - 1);
    }
    if (s.ui.showSafe) {
      o.strokeStyle = 'rgba(255,255,255,0.55)';
      o.lineWidth = 1;
      o.setLineDash([6, 4]);
      const act = 0.035;
      const tit = 0.05;
      o.strokeRect(W * act, H * act, W * (1 - 2 * act), H * (1 - 2 * act));
      o.strokeRect(W * tit, H * tit, W * (1 - 2 * tit), H * (1 - 2 * tit));
      o.setLineDash([]);
      o.beginPath();
      o.moveTo(W / 2 - 12, H / 2);
      o.lineTo(W / 2 + 12, H / 2);
      o.moveTo(W / 2, H / 2 - 12);
      o.lineTo(W / 2, H / 2 + 12);
      o.stroke();
      // 9:16 shorts UI zones (vertical projects)
      if (p.settings.aspect === '9:16') {
        o.fillStyle = 'rgba(255,0,80,0.12)';
        o.fillRect(0, H * 0.8, W, H * 0.2);
        o.fillRect(W * 0.86, H * 0.35, W * 0.14, H * 0.45);
      }
    }
    if (this.notes.length) {
      o.font = `${Math.max(12, H / 36)}px system-ui, sans-serif`;
      o.fillStyle = 'rgba(0,0,0,0.6)';
      const txt = [...new Set(this.notes)].join('  •  ');
      const w = o.measureText(txt).width + 20;
      o.fillRect(10, 10, w, H / 36 + 14);
      o.fillStyle = '#ffd25e';
      o.fillText(txt, 20, 10 + H / 36 + 2);
    }
  }

  /** Capture the current preview frame (used for quick thumbnails). */
  snapshot(): string {
    return this.canvas.toDataURL('image/png');
  }

  markDirty(): void {
    this.dirty = true;
  }
}

function fullFrameLayer(p: Project): LayerState {
  return {
    clip: {} as Clip,
    track: p.tracks[0],
    z: 0,
    local: 0,
    srcTime: 0,
    w: p.settings.width,
    h: p.settings.height,
    cx: p.settings.width / 2,
    cy: p.settings.height / 2,
    rotation: 0,
    opacity: 1,
    blur: 0,
    blurHorizontalOnly: false,
    rgbShift: 0,
    dipColor: [0, 0, 0],
    dipAmount: 0,
    noise: 0,
  };
}
