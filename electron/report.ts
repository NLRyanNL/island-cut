// "Report a problem": writes a plain-text report the user can look at before sending it.
// Personal details are removed: the home folder and user name are replaced, API keys never included.
import { app, dialog, shell, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logDir } from './selftest';
import { publicSettings } from './settings';

function scrub(text: string): string {
  const home = os.homedir();
  const user = os.userInfo().username;
  let t = text.split(home).join('~').split(home.replace(/\\/g, '/')).join('~');
  if (user.length >= 3) t = t.replace(new RegExp(`([\\\\/])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\\\/])`, 'gi'), '$1<user>$2');
  t = t.replace(/sk-ant-[A-Za-z0-9_-]+/g, '<api key removed>');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gi, '<email removed>');
  return t;
}

function tail(file: string, maxBytes = 60_000): string {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
  } catch {
    return '(not found)';
  }
}

export async function createProblemReport(win: BrowserWindow | null, description: string, extra: string): Promise<string | null> {
  const s = publicSettings();
  const settingsSafe = {
    autosaveSeconds: s.autosaveSeconds,
    hasApiKey: s.hasApiKey,
    aiModel: s.aiModel,
    sfxFolderSet: !!s.sfxFolder,
    customPresets: s.customPresets.length,
    uiZoom: s.uiZoom ?? 'auto',
  };
  const report = [
    'IslandCut problem report',
    '========================',
    `Created: ${new Date().toISOString()}`,
    `IslandCut ${app.getVersion()} · Electron ${process.versions.electron} · Chrome ${process.versions.chrome}`,
    `Windows/OS: ${os.type()} ${os.release()} ${os.arch()} · RAM ${Math.round(os.totalmem() / 1e9)} GB · CPUs ${os.cpus().length}× ${os.cpus()[0]?.model ?? ''}`,
    '',
    'What happened (from the user):',
    description.trim() || '(nothing written)',
    '',
    'App state:',
    extra,
    '',
    'Settings (no keys):',
    JSON.stringify(settingsSafe, null, 1),
    '',
    '--- log of this session ---',
    tail(path.join(logDir(), 'app.log')),
    '',
    '--- log of the previous session ---',
    tail(path.join(logDir(), 'app.prev.log'), 30_000),
  ].join('\n');
  const opts = {
    title: 'Save problem report',
    defaultPath: path.join(app.getPath('desktop'), `IslandCut-problem-report-${new Date().toISOString().slice(0, 10)}.txt`),
    filters: [{ name: 'Text file', extensions: ['txt'] }],
  };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, scrub(report), 'utf8');
  shell.showItemInFolder(r.filePath);
  return r.filePath;
}
