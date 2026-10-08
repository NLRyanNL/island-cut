// The API exposed to the renderer by the preload script (window.api).
import type { ExportJob, JobProgress, MediaItem, Project, ProbeResult, WaveformData, BeatAnalysis, ExportPreset } from './types';
import type { TextAsset } from './render/buildGraph';

export interface ProxyInfo {
  mediaId: string;
  state: 'queued' | 'running' | 'ready' | 'error';
  progress: number;
  proxyUrl?: string;
  stripUrl?: string;
  stripInterval?: number;
  stripCount?: number;
  error?: string;
  /** height of the preview copy this update is about (540 smooth, 1080 high) */
  height?: number;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PublicSettings {
  recentProjects: string[];
  customPresets: ExportPreset[];
  lastExportDir?: string;
  lastImportDir?: string;
  sfxFolder?: string;
  aiModel?: string;
  autosaveSeconds: number;
  hasApiKey: boolean;
  previewQuality?: 'smooth' | 'high' | 'original';
  /** this build has an install counter configured */
  statsEnabled: boolean;
  usageStatsOff?: boolean;
}

export interface DerivedRequest {
  op: 'reverse' | 'freeze';
  sourcePath: string;
  /** reverse: source range; freeze: time */
  srcIn: number;
  srcOut?: number;
  fps: number;
}

export interface AiRequest {
  system: string;
  prompt: string;
  /** Base64 JPEG images (frames) to attach. */
  images?: string[];
  maxTokens?: number;
}

export interface FrameSample {
  time: number;
  jpegBase64: string;
}

export type MediaAnalysis = import('./analysis').FootageAnalysis & { mediaId: string };

export interface Api {
  platform: string;
  /** true when launched by the automated UI tests */
  testMode: boolean;
  /** true when launched with UTS_SELFTEST=1 */
  selftest: boolean;
  selftestMedia(): Promise<{ dir: string; files: Record<string, string> }>;
  selftestDone(report: unknown): Promise<void>;
  // dialogs
  openFiles(opts: { title?: string; filters?: FileFilter[]; multi?: boolean; folder?: boolean }): Promise<string[]>;
  saveFile(opts: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
  confirm(opts: { message: string; detail?: string; buttons: string[]; cancelId?: number; defaultId?: number }): Promise<number>;
  showInFolder(path: string): void;
  getPathForFile(file: File): string;
  // media
  probe(paths: string[]): Promise<ProbeResult[]>;
  mediaUrl(path: string): string;
  thumbnail(path: string, kind: 'video' | 'image', duration: number): Promise<string | null>;
  requestProxy(media: MediaItem): Promise<void>;
  waveform(path: string): Promise<WaveformData | null>;
  detectBeats(path: string): Promise<BeatAnalysis>;
  makeDerived(req: DerivedRequest): Promise<{ path: string }>;
  listFolder(folder: string, exts: string[]): Promise<string[]>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Write an image to a path the user chose in a Save dialog. */
  writeUserFile(path: string, data: Uint8Array): Promise<void>;
  exists(paths: string[]): Promise<boolean[]>;
  findInFolder(folder: string, names: string[]): Promise<Record<string, string>>;
  allowPaths(paths: string[]): Promise<void>;
  onProxyProgress(cb: (p: ProxyInfo) => void): () => void;
  // project
  saveProject(project: Project, path: string): Promise<void>;
  loadProject(path: string): Promise<Project>;
  autosave(project: Project, path: string | null): Promise<string>;
  listAutosaves(): Promise<{ path: string; name: string; modified: number }[]>;
  // export
  exportPrepare(jobId: string): Promise<string>;
  writeJobFile(dir: string, name: string, data: Uint8Array): Promise<void>;
  exportRun(job: ExportJob, project: Project, textAssets: Record<string, TextAsset>): Promise<string>;
  exportCancel(jobId: string): void;
  onExportProgress(cb: (p: JobProgress) => void): () => void;
  // analysis / AI
  analyzeMedia(media: MediaItem): Promise<MediaAnalysis>;
  sampleFrames(path: string, times: number[], width: number): Promise<FrameSample[]>;
  aiComplete(req: AiRequest): Promise<string>;
  // settings
  getSettings(): Promise<PublicSettings>;
  updateSettings(patch: Partial<PublicSettings>): Promise<PublicSettings>;
  setApiKey(key: string | null): Promise<PublicSettings>;
  listFonts(): Promise<string[]>;
  /** Built-in, generated sound effects (made on first use). */
  builtinSfx(): Promise<BuiltinSfx[]>;
  checkForUpdate(): Promise<UpdateInfo>;
  /** Save a problem report (no personal info) and show it in Explorer; returns its path. */
  createProblemReport(description: string, extra: string): Promise<string | null>;
  /** GitHub repo used for updates / issues ("" when not set up). */
  appInfo(): Promise<{ version: string; updateRepo: string }>;
  /** Interface size: setting null = automatic. */
  getUiZoom(): Promise<UiZoom>;
  setUiZoom(z: number | null): Promise<UiZoom>;
  /** Fonts shipped with the app (resources/fonts/fonts.json). */
  bundledFonts(): Promise<BundledFont[]>;
  bundledFontBytes(file: string): Promise<Uint8Array>;
  // app lifecycle
  onMenu(cb: (cmd: string) => void): () => void;
  onCloseRequested(cb: () => void): () => void;
  confirmClose(): void;
  setTitle(title: string): void;
  openExternal(url: string): void;
}

declare global {
  interface Window {
    api: Api;
  }
}

export interface BundledFont {
  id: string;
  family: string;
  category: string;
  faces: { weight: number; file: string }[];
  license: string;
}

export interface UiZoom {
  setting: number | null;
  auto: number;
  effective: number;
}

export interface BuiltinSfx {
  id: string;
  name: string;
  use: string;
  path: string;
}

export interface UpdateInfo {
  status: 'not-configured' | 'up-to-date' | 'available' | 'error';
  current: string;
  latest?: string;
  url?: string;
  notes?: string;
  message?: string;
}
