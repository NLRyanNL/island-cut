import type {
  AdjustProps,
  AspectId,
  Clip,
  ClipKind,
  ColorSettings,
  ExportPreset,
  MediaItem,
  Project,
  ProjectSettings,
  TextProps,
  Track,
  TrackKind,
  Transform,
  AudioRole,
} from './types';
import { constProp } from './keyframes';
import { uid } from './time';

export const ASPECTS: Record<AspectId, { width: number; height: number; label: string }> = {
  '16:9': { width: 1920, height: 1080, label: '16:9 Landscape (1920x1080)' },
  '9:16': { width: 1080, height: 1920, label: '9:16 Vertical (1080x1920)' },
  '1:1': { width: 1080, height: 1080, label: '1:1 Square (1080x1080)' },
};

export function defaultSettings(aspect: AspectId = '16:9', fps = 60): ProjectSettings {
  const a = ASPECTS[aspect];
  return {
    width: a.width,
    height: a.height,
    fps,
    aspect,
    sampleRate: 48000,
    backgroundColor: '#000000',
    duckingEnabled: false,
    duckAmountDb: 10,
    duckAttack: 0.12,
    duckRelease: 0.45,
    duckThresholdDb: -38,
    snapToBeats: false,
    normalizeLoudness: true,
    targetLufs: -14,
  };
}

export function makeTrack(kind: TrackKind, name: string, role?: AudioRole): Track {
  return { id: uid('trk_'), kind, name, muted: false, hidden: false, locked: false, role, volume: 1 };
}

/**
 * Track order in the array is the compositing / display order:
 * text tracks first (top), then video tracks from top (V4) to bottom (V1), then audio A1..A4.
 */
export function defaultTracks(): Track[] {
  return [
    makeTrack('text', 'T1'),
    makeTrack('video', 'V4'),
    makeTrack('video', 'V3'),
    makeTrack('video', 'V2'),
    makeTrack('video', 'V1'),
    makeTrack('audio', 'A1 Game', 'game'),
    makeTrack('audio', 'A2 Music', 'music'),
    makeTrack('audio', 'A3 SFX', 'sfx'),
    makeTrack('audio', 'A4 Voice', 'voice'),
  ];
}

export function createProject(name = 'Untitled Trailer', aspect: AspectId = '16:9', fps = 60): Project {
  const now = new Date().toISOString();
  return {
    format: 'uefn-trailer-project',
    version: 1,
    id: uid('prj_'),
    name,
    createdAt: now,
    modifiedAt: now,
    settings: defaultSettings(aspect, fps),
    media: {},
    tracks: defaultTracks(),
    clips: {},
    markers: [],
    fonts: [],
  };
}

export function defaultTransform(): Transform {
  return {
    x: constProp(0),
    y: constProp(0),
    scale: constProp(1),
    rotation: constProp(0),
    opacity: constProp(1),
  };
}

export function defaultColor(): ColorSettings {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    vignette: 0,
    look: 'none',
    lookIntensity: 1,
    lutIntensity: 1,
  };
}

export function defaultText(text = 'YOUR TITLE'): TextProps {
  return {
    text,
    fontFamily: 'Arial Black',
    fontWeight: 900,
    italic: false,
    fontSize: 120,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 0,
    shadowColor: 'rgba(0,0,0,0.6)',
    shadowBlur: 18,
    shadowOffset: 6,
    align: 'center',
    letterSpacing: 2,
    lineHeight: 1.1,
    posX: 0.5,
    posY: 0.5,
    box: false,
    boxColor: '#1b1f3a',
    boxPadding: 30,
    boxRadius: 16,
    accentBar: false,
    accentColor: '#ffd23f',
    animIn: 'fadeUp',
    animOut: 'none',
    animInDuration: 0.5,
    animOutDuration: 0.35,
    uppercase: false,
  };
}

export function defaultAdjust(): AdjustProps {
  return { letterbox: true, letterboxRatio: 2.39 };
}

export function makeClip(kind: ClipKind, trackId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return {
    id: uid('clp_'),
    trackId,
    kind,
    name: extra.name ?? kind,
    start,
    duration,
    in: 0,
    speed: 1,
    reversed: false,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    muted: false,
    fit: 'fill',
    transform: defaultTransform(),
    color: defaultColor(),
    shakes: [],
    ...extra,
  };
}

export function clipFromMedia(m: MediaItem, trackId: string, start: number, fps: number): Clip {
  const kind: ClipKind = m.kind === 'image' ? 'image' : m.kind === 'audio' ? 'audio' : m.hasVideo ? 'video' : 'audio';
  const dur = m.kind === 'image' ? 3 : Math.max(1 / fps, Math.floor(m.duration * fps) / fps);
  return makeClip(kind, trackId, start, dur, { mediaId: m.id, name: m.name, fit: m.kind === 'image' ? 'fit' : 'fill' });
}

// ---------------- Export presets ----------------

export const BUILTIN_PRESETS: ExportPreset[] = [
  {
    id: 'yt1080p60',
    name: 'YouTube 1080p60',
    width: 1920,
    height: 1080,
    fps: 60,
    codec: 'h264',
    bitrateMbps: 16,
    crf: 18,
    audioBitrateKbps: 320,
    speed: 'medium',
    builtIn: true,
  },
  {
    id: 'yt4k',
    name: 'YouTube 4K',
    width: 3840,
    height: 2160,
    fps: 60,
    codec: 'h264',
    bitrateMbps: 50,
    crf: 18,
    audioBitrateKbps: 320,
    speed: 'fast',
    builtIn: true,
  },
  {
    id: 'shorts',
    name: 'Shorts / TikTok 1080x1920',
    width: 1080,
    height: 1920,
    fps: 60,
    codec: 'h264',
    bitrateMbps: 12,
    crf: 19,
    audioBitrateKbps: 256,
    speed: 'medium',
    maxDurationSec: 60,
    builtIn: true,
  },
  {
    id: 'draft',
    name: 'Quick Draft 720p',
    width: 1280,
    height: 720,
    fps: 30,
    codec: 'h264',
    bitrateMbps: 0,
    crf: 26,
    audioBitrateKbps: 160,
    speed: 'veryfast',
    builtIn: true,
  },
  {
    id: 'fortnite-island',
    name: 'Fortnite Island Trailer (edit me)',
    width: 1920,
    height: 1080,
    fps: 60,
    codec: 'h264',
    bitrateMbps: 20,
    crf: 18,
    audioBitrateKbps: 320,
    speed: 'medium',
    maxDurationSec: 0,
    maxFileSizeMB: 0,
    notes:
      'Fill in Epic\'s current island trailer requirements (resolution, fps, max length, max file size). ' +
      'Check the Fortnite Creator Portal docs before publishing; requirements change.',
    builtIn: true,
    editable: true,
  },
  {
    id: 'custom',
    name: 'Custom',
    width: 1920,
    height: 1080,
    fps: 60,
    codec: 'h264',
    bitrateMbps: 16,
    crf: 18,
    audioBitrateKbps: 320,
    speed: 'medium',
    builtIn: true,
    editable: true,
  },
];

export const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];
export const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
export const ALL_MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS];

export function extOf(p: string): string {
  const m = /\.([^./\\]+)$/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
