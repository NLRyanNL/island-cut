// Lists installed system font families (for the text font picker).
import { app } from 'electron';
import fsB from 'node:fs';
import pathB from 'node:path';
import type { BundledFont } from '../shared/api';
import { execFile } from 'node:child_process';

const FALLBACK = ['Arial', 'Arial Black', 'Impact', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Consolas'];

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

let cached: string[] | null = null;

export async function listSystemFonts(): Promise<string[]> {
  if (cached) return cached;
  let names: string[] = [];
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }",
    ]);
    names = out.split(/\r?\n/);
  } else if (process.platform === 'darwin') {
    const out = await run('/usr/bin/fc-list', [':', 'family']);
    names = out.split(/\r?\n/).map((l) => l.split(',')[0]);
  } else {
    const out = await run('fc-list', [':', 'family']);
    names = out.split(/\r?\n/).map((l) => l.split(',')[0]);
  }
  const set = new Set(names.map((n) => n.trim()).filter(Boolean));
  if (set.size === 0) FALLBACK.forEach((f) => set.add(f));
  cached = [...set].sort((a, b) => a.localeCompare(b));
  return cached;
}


// ------------------------------------------------------------------ bundled fonts

function bundledDir(): string {
  // dev: <project>/resources/fonts · packaged: <install>/resources/fonts
  return app.isPackaged ? pathB.join(process.resourcesPath, 'fonts') : pathB.join(__dirname, '..', '..', 'resources', 'fonts');
}

export function listBundledFonts(): BundledFont[] {
  try {
    return JSON.parse(fsB.readFileSync(pathB.join(bundledDir(), 'fonts.json'), 'utf8')) as BundledFont[];
  } catch {
    return [];
  }
}

export function readBundledFont(file: string): Uint8Array {
  // only plain names from the manifest: never a path
  if (!/^[a-z0-9-]+-\d+\.woff2$/.test(file)) throw new Error('bad font name');
  return new Uint8Array(fsB.readFileSync(pathB.join(bundledDir(), file)));
}
