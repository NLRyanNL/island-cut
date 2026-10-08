// Anonymous install counter (optional). Only active when the build has a counter URL configured
// (package.json "islandcut.statsUrl") and the user has not switched it off in Settings.
// What is sent: a random id made on first launch, the event ("install" once, "open" at most
// once a day), the app version and the OS family. Nothing else: no name, no files, no hardware.
import { app, net } from 'electron';
import crypto from 'node:crypto';
import { getSettings, statsUrl, updateSettings } from './settings';

async function send(url: string, body: Record<string, string>): Promise<boolean> {
  try {
    const r = await net.fetch(`${url}/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false; // offline etc.: try again next launch
  }
}

export async function pingStats(): Promise<void> {
  const url = statsUrl();
  if (!url || process.env.UTS_SELFTEST) return;
  const s = getSettings();
  if (s.usageStatsOff) return;
  let id = s.installId;
  if (!id) {
    id = crypto.randomUUID();
    updateSettings({ installId: id });
  }
  const base = { id, version: app.getVersion(), os: process.platform };
  if (!s.installPinged) {
    if (await send(url, { ...base, event: 'install' })) updateSettings({ installPinged: true });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (getSettings().lastOpenPing !== today) {
    if (await send(url, { ...base, event: 'open' })) updateSettings({ lastOpenPing: today });
  }
}
