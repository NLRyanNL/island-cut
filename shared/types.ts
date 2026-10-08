// Core data model shared by the Electron main process and the React renderer.
// All times are in seconds (floating point) and are quantized to project frames on edit.

export type MediaKind = 'video' | 'audio' | 'image';
export type TrackKind = 'video' | 'audio' | 'text';
export type ClipKind = 'video' | 'audio' | 'image' | 'text' | 'adjust';
export type AudioRole = 'game' | 'music' | 'sfx' | 'voice';
export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold';

export interface MediaItem {
  id: string;
  kind: MediaKind;
  name: string;
  /** Absolute path at runtime. Stored relative to the project file on disk. */
  path: string;
  /** Bin folder: regular media, music or the sound-effects folder. */
  folder: 'media' | 'music' | 'sfx';
  duration: number; // seconds (images: 0 = unlimited)
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels: number;
  sampleRate: number;
  codec: string;
  fileSize: number;
  mtimeMs: number;
  /** Set when this media was derived from another one (e.g. a reversed copy). */
  derivedFrom?: { mediaId: string; op: 'reverse' | 'freeze'; srcIn?: number; srcOut?: number };
  /** Detected beats in source seconds (music). */
  beats?: number[];
  bpm?: number;
  missing?: boolean;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  /** Audio tracks only: used for auto-ducking. */
  role?: AudioRole;
  /** Track volume (linear). */
  volume: number;
}

export interface Keyframe {
  /** Clip-local time in seconds (0 = clip start on the timeline). */
  t: number;
  v: number;
  ease: Ease;
}

/** A numeric property that is either constant (value) or animated (keys, if 2+ entries). */
export interface AnimProp {
  value: number;
  keys?: Keyframe[];
}

export interface Transform {
  /** Offset from frame center, in output pixels. */
  x: AnimProp;
  y: AnimProp;
  /** 1 = fit/fill size. */
  scale: AnimProp;
  /** Degrees, clockwise. */
  rotation: AnimProp;
  /** 0..1 */
  opacity: AnimProp;
}

export type FitMode = 'fit' | 'fill' | 'stretch';

export interface ColorSettings {
  brightness: number; // -1..1 (0 neutral)
  contrast: number; // -1..1
  saturation: number; // -1..1
  temperature: number; // -1..1 (negative = cooler/blue, positive = warmer)
  tint: number; // -1..1 (negative = green, positive = magenta)
  vignette: number; // 0..1
  look: LookId;
  lookIntensity: number; // 0..1
  /** Absolute path of an imported .cube LUT (stored relative in the project file). */
  lutPath?: string;
  lutIntensity: number; // 0..1
}

export type LookId = 'none' | 'cinematic' | 'horror' | 'vibrant';

export interface ShakeEvent {
  /** Clip-local start time. */
  at: number;
  duration: number;
  /** 0..1 */
  intensity: number;
  /** Shakes per second. */
  frequency: number;
}

export type TransitionType =
  | 'crossfade'
  | 'blurDissolve'
  | 'dipBlack'
  | 'dipWhite'
  | 'flash'
  | 'lightLeak'
  | 'filmBurn'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'pushLeft'
  | 'pushRight'
  | 'pushUp'
  | 'pushDown'
  | 'wipeLeft'
  | 'wipeRight'
  | 'wipeUp'
  | 'wipeDown'
  | 'wipeDiagonal'
  | 'iris'
  | 'diamond'
  | 'clockWipe'
  | 'blinds'
  | 'barsVertical'
  | 'zoomIn'
  | 'zoomPunch'
  | 'zoomBlur'
  | 'spin'
  | 'whipPan'
  | 'whipRight'
  | 'whipUp'
  | 'whipDown'
  | 'glitch'
  | 'rgbSplit'
  | 'shakeCut';

/** Shape of a wipe-style reveal (see shared/transitions.ts). */
export type MaskKind = 'linear' | 'circle' | 'diamond' | 'clock' | 'bands';

export interface TransitionSpec {
  type: TransitionType;
  duration: number;
}

export type TextAnimation = 'none' | 'fadeUp' | 'scalePunch' | 'typewriter' | 'glitchIn' | 'slam';

export interface TextProps {
  text: string;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number; // px at project resolution height 1080 (scaled for other sizes)
  color: string;
  outlineColor: string;
  outlineWidth: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffset: number;
  align: 'left' | 'center' | 'right';
  letterSpacing: number;
  lineHeight: number;
  /** Anchor position as fraction of frame (0..1). */
  posX: number;
  posY: number;
  /** Box behind the text (used by island-code cards and lower thirds). */
  box: boolean;
  boxColor: string;
  boxPadding: number;
  boxRadius: number;
  /** Optional accent bar left of the text (lower thirds). */
  accentBar: boolean;
  accentColor: string;
  animIn: TextAnimation;
  animOut: TextAnimation;
  animInDuration: number;
  animOutDuration: number;
  /** Optional secondary line rendered smaller below the main text. */
  subText?: string;
  subSize?: number;
  subColor?: string;
  uppercase: boolean;
}

export interface AdjustProps {
  letterbox: boolean;
  letterboxRatio: number; // 2.39
}

export interface Clip {
  id: string;
  trackId: string;
  kind: ClipKind;
  mediaId?: string;
  name: string;
  /** Timeline position. */
  start: number;
  /** Timeline duration. */
  duration: number;
  /** Source in-point (seconds of source media). */
  in: number;
  /** Constant speed (ignored when speedKeys has 2+ keys). */
  speed: number;
  /** Speed ramp keyframes, clip-local time -> speed. */
  speedKeys?: Keyframe[];
  /** Reverse playback (uses a reversed render of the source range). */
  reversed: boolean;
  /** Audio */
  volume: number; // linear gain, 1 = 0 dB
  volumeKeys?: Keyframe[];
  fadeIn: number;
  fadeOut: number;
  /** Picture fade from/to a colour (or to transparent) at the clip's start / end, seconds. */
  videoFadeIn?: number;
  videoFadeOut?: number;
  fadeColor?: 'black' | 'white' | 'transparent';
  /** Constant gaussian blur of the picture (px at 1080p), e.g. a blurry end-card background. */
  blur?: number;
  muted: boolean;
  /** Video clip whose audio has been extracted to a separate audio clip. */
  audioDetached?: boolean;
  /** Clips sharing a linkId move/trim/split/delete together. */
  linkId?: string;
  /** Visual */
  fit: FitMode;
  transform: Transform;
  color: ColorSettings;
  shakes: ShakeEvent[];
  transitionIn?: TransitionSpec;
  text?: TextProps;
  adjust?: AdjustProps;
  /** HUD clean-up: regions (normalized 0..1 of the source frame) filled from their surroundings. */
  cleanup?: { x: number; y: number; w: number; h: number }[];
  /** Auto-reframe: keeps a (keyframeable) source point centered when the aspect differs. */
  reframe?: { enabled: boolean; focusX: AnimProp; focusY: AnimProp };
  label?: string;
}

export interface Marker {
  id: string;
  time: number;
  label: string;
  color: string;
  kind: 'user' | 'beat' | 'section';
}

export type AspectId = '16:9' | '9:16' | '1:1';

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  aspect: AspectId;
  sampleRate: number;
  backgroundColor: string;
  duckingEnabled: boolean;
  duckAmountDb: number; // how much quieter music gets (positive dB)
  duckAttack: number; // seconds
  duckRelease: number; // seconds
  duckThresholdDb: number; // level that counts as "has sound"
  snapToBeats: boolean;
  normalizeLoudness: boolean;
  targetLufs: number;
}

export interface CustomFont {
  family: string;
  path: string;
}

export interface Project {
  format: 'uefn-trailer-project';
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  settings: ProjectSettings;
  media: Record<string, MediaItem>;
  tracks: Track[];
  clips: Record<string, Clip>;
  markers: Marker[];
  fonts: CustomFont[];
  /** In/out range for export and loop playback. */
  inPoint?: number;
  outPoint?: number;
}

// ---------- Export ----------

export type VideoCodec = 'h264' | 'h265';

export interface ExportPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  codec: VideoCodec;
  /** Video bitrate in Mbit/s (0 = use CRF quality). */
  bitrateMbps: number;
  crf: number;
  audioBitrateKbps: number;
  /** Encoder speed preset. */
  speed: 'ultrafast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow';
  maxDurationSec?: number;
  maxFileSizeMB?: number;
  notes?: string;
  builtIn?: boolean;
  editable?: boolean;
}

export type ExportKind = 'video' | 'audio-mp3' | 'audio-wav' | 'frame-png';

export interface ExportJob {
  id: string;
  kind: ExportKind;
  outputPath: string;
  preset: ExportPreset;
  /** Timeline range to render. */
  rangeStart: number;
  rangeEnd: number;
  /** Optional: only render these clips (audio export of a single clip). */
  onlyClipIds?: string[];
  normalizeLoudness: boolean;
  targetLufs: number;
  label: string;
}

export type JobStatus = 'queued' | 'preparing' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobProgress {
  jobId: string;
  status: JobStatus;
  progress: number; // 0..1
  message?: string;
  outputPath?: string;
  fps?: number;
  etaSec?: number;
}

// ---------- Media analysis ----------

export interface ProbeResult {
  ok: boolean;
  error?: string;
  kind?: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels: number;
  sampleRate: number;
  codec: string;
  fileSize: number;
  mtimeMs: number;
}

export interface ProxyStatus {
  mediaId: string;
  state: 'none' | 'queued' | 'running' | 'ready' | 'error' | 'not-needed';
  progress: number;
  proxyPath?: string;
  error?: string;
}

/** Peak data for waveform drawing: `peaksPerSec` max-abs values per second of source. */
export interface WaveformData {
  peaksPerSec: number;
  peaks: number[]; // 0..1
  duration: number;
}

export interface BeatAnalysis {
  bpm: number;
  beats: number[];
  downbeats: number[];
}
