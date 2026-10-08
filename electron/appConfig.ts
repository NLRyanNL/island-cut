// Build-time settings of this copy of IslandCut (package.json "islandcut" block).
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  /** install counter endpoint (https://…), empty = off */
  statsUrl: string;
  /** GitHub "owner/repo" whose releases are checked for updates, empty = off */
  updateRepo: string;
}

let cached: AppConfig | null = null;

export function appConfig(): AppConfig {
  if (cached) return cached;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))?.islandcut ?? {};
  } catch {
    /* defaults */
  }
  const url = String(raw.statsUrl ?? '').trim();
  const repo = String(raw.updateRepo ?? '').trim();
  cached = {
    statsUrl: /^https:\/\//.test(url) ? url.replace(/\/$/, '') : '',
    updateRepo: /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '',
  };
  return cached;
}
