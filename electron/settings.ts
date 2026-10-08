// App-level settings (not per project): recent projects, custom export presets, API key (encrypted).
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ExportPreset } from '../shared/types';
import { appConfig } from './appConfig';

export interface AppSettings {
  recentProjects: string[];
  customPresets: ExportPreset[];
  lastExportDir?: string;
  lastImportDir?: string;
  sfxFolder?: string;
  apiKeyEnc?: string;
  aiModel?: string;
  autosaveSeconds: number;
  /** anonymous install counter (see electron/stats.ts) */
  installId?: string;
  installPinged?: boolean;
  lastOpenPing?: string;
  usageStatsOff?: boolean;
  /** preview sharpness: smooth = 540p copies, high = 1080p copies (default), original = play the files themselves */
  previewQuality?: 'smooth' | 'high' | 'original';
  /** interface zoom (1 = 100%); undefined = automatic for the screen */
  uiZoom?: number;
}

const defaults: AppSettings = { recentProjects: [], customPresets: [], autosaveSeconds: 30 };
let cache: AppSettings | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    cache = { ...defaults, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...defaults };
  }
  return cache!;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  cache = { ...getSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 1));
  } catch {
    /* ignore */
  }
  return cache;
}

export function addRecent(p: string): void {
  const s = getSettings();
  updateSettings({ recentProjects: [p, ...s.recentProjects.filter((x) => x !== p)].slice(0, 12) });
}

export function setApiKey(key: string | null): void {
  if (!key) {
    updateSettings({ apiKeyEnc: undefined });
    return;
  }
  const enc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key).toString('base64') : 'plain:' + Buffer.from(key).toString('base64');
  updateSettings({ apiKeyEnc: enc });
}

export function getApiKey(): string | null {
  const e = getSettings().apiKeyEnc;
  if (!e) return process.env.ANTHROPIC_API_KEY || null;
  try {
    if (e.startsWith('plain:')) return Buffer.from(e.slice(6), 'base64').toString();
    return safeStorage.decryptString(Buffer.from(e, 'base64'));
  } catch {
    return null;
  }
}

/** Settings safe to send to the renderer (no key). */
export function publicSettings(): Omit<AppSettings, 'apiKeyEnc' | 'installId'> & { hasApiKey: boolean; statsEnabled: boolean } {
  const { apiKeyEnc, installId: _id, ...rest } = getSettings();
  void _id;
  return { ...rest, hasApiKey: !!apiKeyEnc || !!process.env.ANTHROPIC_API_KEY, statsEnabled: !!statsUrl() };
}

/** Counter endpoint baked into this build (package.json "islandcut.statsUrl"); empty = no counting. */
export function statsUrl(): string {
  return appConfig().statsUrl;
}
