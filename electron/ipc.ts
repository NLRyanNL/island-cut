import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { builtinSfx } from './sfx';
import { checkForUpdate } from './updates';
import { createProblemReport } from './report';
import { appConfig } from './appConfig';
import fs from 'node:fs';
import path from 'node:path';
import type { ExportJob, JobProgress, MediaItem, Project } from '../shared/types';
import type { AiRequest, DerivedRequest, ProxyInfo } from '../shared/api';
import type { TextAsset } from '../shared/render/buildGraph';
import { probeMedia } from './ffmpeg/probe';
import { makeProxy, makeThumbnail, makeWaveform, existingProxy, type ProxyHeight } from './ffmpeg/mediaJobs';
import { mediaUrl } from './mediaProtocol';
import { cacheDir, jobDir } from './paths';
import { loadProject, saveProject, serializeProject, writeFileAtomic, findInFolder } from './project/projectIO';
import { runExport } from './export/exporter';
import { addRecent, getApiKey, getSettings, publicSettings, setApiKey, updateSettings } from './settings';
import { ALL_MEDIA_EXTS } from '../shared/defaults';
import { listSystemFonts, listBundledFonts, readBundledFont } from './fonts';
import { duckGainFunction } from './audio/ducking';
import { detectBeatsForFile } from './audio/beats';
import { makeDerivedMedia } from './ffmpeg/derived';
import { analyzeMediaFile, sampleFrames } from './analysis/analyze';
import { aiComplete } from './analysis/ai';

const allowed = new Set<string>();

const key = (p: string) => {
  const n = path.resolve(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

/** True if `file` is `root` itself or inside it (separator-safe: C:\cache2 is NOT inside C:\cache). */
export function isInside(root: string, file: string): boolean {
  const rel = path.relative(key(root), key(file));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isAllowedPath(file: string): boolean {
  if (!file) return false;
  if (allowed.has(key(file))) return true;
  try {
    if (isInside(cacheDir(''), file)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

const allowedDirs = new Set<string>();

export function allowPath(p: string): void {
  if (!p) return;
  allowed.add(key(p));
  allowedDirs.add(key(path.dirname(p)));
}

function assertAllowed(p: string): void {
  if (!isAllowedPath(p)) throw new Error('Access to this file was not granted');
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const exportAborts = new Map<string, AbortController>();

export function registerIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('dialog:open', async (_e, opts: { title?: string; filters?: Electron.FileFilter[]; multi?: boolean; folder?: boolean }) => {
    const win = getWin();
    const props: Electron.OpenDialogOptions['properties'] = opts.folder ? ['openDirectory'] : ['openFile'];
    if (opts.multi) props.push('multiSelections');
    const r = await dialog.showOpenDialog(win!, { title: opts.title, filters: opts.filters, properties: props });
    for (const p of r.filePaths) allowPath(p);
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:save', async (_e, opts: { title?: string; defaultPath?: string; filters?: Electron.FileFilter[] }) => {
    const r = await dialog.showSaveDialog(getWin()!, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
    if (r.filePath) allowPath(r.filePath);
    return r.canceled ? null : r.filePath ?? null;
  });
  ipcMain.handle('dialog:confirm', async (_e, o: { message: string; detail?: string; buttons: string[]; cancelId?: number; defaultId?: number }) => {
    const r = await dialog.showMessageBox(getWin()!, { type: 'question', message: o.message, detail: o.detail, buttons: o.buttons, cancelId: o.cancelId, defaultId: o.defaultId, noLink: true });
    return r.response;
  });
  ipcMain.on('shell:showInFolder', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });

  // ---------------------------------------------------------- media
  // The renderer may only widen access next to files the user already picked (e.g. "logo" → "logo.png"
  // in the folder chosen in a Save dialog); anything else is ignored.
  ipcMain.handle('media:allow', (_e, paths: string[]) => {
    for (const p of paths) if (typeof p === 'string' && allowedDirs.has(key(path.dirname(p)))) allowPath(p);
  });
  ipcMain.handle('media:probe', async (_e, paths: string[]) => {
    const out = [];
    for (const p of paths) {
      // dropped / imported media files (by extension only: never project, settings or system files)
      if (typeof p === 'string' && ALL_MEDIA_EXTS.includes(path.extname(p).slice(1).toLowerCase())) allowPath(p);
      out.push(await probeMedia(p));
    }
    return out;
  });
  ipcMain.handle('media:thumb', async (_e, p: string, kind: 'video' | 'image', duration: number) => {
    try {
      return mediaUrl(await makeThumbnail(p, kind, duration));
    } catch {
      return null;
    }
  });
  ipcMain.handle('media:waveform', async (_e, p: string) => {
    try {
      return await makeWaveform(p);
    } catch {
      return null;
    }
  });
  ipcMain.handle('media:proxy', async (_e, m: MediaItem) => {
    const win = getWin();
    // "Smooth" preview = 540p copy; "High" and "Original" = 1080p copy (Original plays the file itself when it can)
    const height: ProxyHeight = (getSettings().previewQuality ?? 'high') === 'smooth' ? 540 : 1080;
    const ready = existingProxy(m.path, height);
    const info = (extra: Partial<ProxyInfo>): ProxyInfo => ({ mediaId: m.id, state: 'queued', progress: 0, height, ...extra });
    if (ready) {
      send(win, 'media:proxy-progress', info({ state: 'ready', progress: 1, proxyUrl: mediaUrl(ready.proxyPath), stripUrl: mediaUrl(ready.stripPath), stripInterval: ready.stripInterval, stripCount: ready.stripCount }));
      return;
    }
    send(win, 'media:proxy-progress', info({ state: 'queued' }));
    let last = 0;
    makeProxy(
      m.path,
      m,
      (k) => {
        const now = Date.now();
        if (now - last < 250) return;
        last = now;
        send(getWin(), 'media:proxy-progress', info({ state: 'running', progress: k }));
      },
      height,
    )
      .then((r) =>
        send(getWin(), 'media:proxy-progress', info({ state: 'ready', progress: 1, proxyUrl: mediaUrl(r.proxyPath), stripUrl: mediaUrl(r.stripPath), stripInterval: r.stripInterval, stripCount: r.stripCount })),
      )
      .catch((e: Error) => send(getWin(), 'media:proxy-progress', info({ state: 'error', error: e.message })));
  });
  ipcMain.handle('media:beats', async (_e, p: string) => detectBeatsForFile(p));
  ipcMain.handle('media:derived', async (_e, req: DerivedRequest) => {
    const r = await makeDerivedMedia(req);
    allowPath(r.path);
    return r;
  });
  ipcMain.handle('media:analyze', async (_e, m: MediaItem) => analyzeMediaFile(m));
  ipcMain.handle('media:sampleFrames', async (_e, p: string, times: number[], width: number) => sampleFrames(p, times, width));
  ipcMain.handle('fs:listFolder', async (_e, folder: string, exts: string[]) => {
    // only folders the user picked (now or as the saved sound-effects folder)
    if (!isAllowedPath(folder) && key(folder) !== key(getSettings().sfxFolder ?? '')) throw new Error('Access to this folder was not granted');
    allowPath(folder);
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(full, depth + 1);
        else if (e.isFile() && exts.includes(path.extname(e.name).slice(1).toLowerCase())) {
          out.push(full);
          allowPath(full);
        }
      }
    };
    walk(folder, 0);
    return out.sort();
  });
  ipcMain.handle('fs:readText', async (_e, p: string) => {
    assertAllowed(p);
    return fs.promises.readFile(p, 'utf8');
  });
  ipcMain.handle('fs:readBytes', async (_e, p: string) => {
    assertAllowed(p);
    return new Uint8Array(await fs.promises.readFile(p));
  });
  ipcMain.handle('fs:writeUserFile', async (_e, p: string, data: Uint8Array) => {
    // only files the user picked in a Save dialog, and only images
    assertAllowed(p);
    if (!/\.(png|jpe?g)$/i.test(p)) throw new Error('Only PNG/JPG files can be written');
    await fs.promises.writeFile(p, data);
  });
  ipcMain.handle('fs:exists', async (_e, paths: string[]) => paths.map((p) => fs.existsSync(p)));
  ipcMain.handle('fs:findInFolder', async (_e, folder: string, names: string[]) => {
    const r = findInFolder(folder, names);
    Object.values(r).forEach(allowPath);
    return r;
  });

  // ---------------------------------------------------------- project
  ipcMain.handle('project:save', async (_e, project: Project, file: string) => {
    saveProject(project, file);
    addRecent(file);
  });
  ipcMain.handle('project:load', async (_e, file: string) => {
    const p = loadProject(file);
    for (const m of Object.values(p.media)) allowPath(m.path);
    for (const f of p.fonts ?? []) allowPath(f.path);
    for (const c of Object.values(p.clips)) if (c.color?.lutPath) allowPath(c.color.lutPath);
    addRecent(file);
    return p;
  });
  ipcMain.handle('project:autosave', async (_e, project: Project) => {
    // Autosave never touches the user's project file (that only changes on an explicit Save).
    // It writes a recovery copy, serialized relative to its own location, that File → Recover opens.
    const rec = path.join(cacheDir('autosave'), `${project.id}.json`);
    writeFileAtomic(rec, serializeProject(project, rec));
    return rec;
  });
  ipcMain.handle('project:listAutosaves', async () => {
    const d = cacheDir('autosave');
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(d, f);
        let name = f;
        try {
          name = JSON.parse(fs.readFileSync(full, 'utf8')).name ?? f;
        } catch {
          /* ignore */
        }
        allowPath(full);
        return { path: full, name, modified: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
  });

  // ---------------------------------------------------------- export
  ipcMain.handle('export:prepare', async (_e, jobId: string) => jobDir(jobId));
  ipcMain.handle('export:writeFile', async (_e, dir: string, name: string, data: Uint8Array) => {
    const target = path.join(dir, name);
    if (!isInside(cacheDir('jobs'), target) || key(target) === key(cacheDir('jobs'))) throw new Error('Invalid job path');
    await fs.promises.writeFile(target, data);
  });
  ipcMain.handle('export:run', async (_e, job: ExportJob, project: Project, textAssets: Record<string, TextAsset>) => {
    const ac = new AbortController();
    exportAborts.set(job.id, ac);
    allowPath(job.outputPath);
    const report = (p: JobProgress) => send(getWin(), 'export:progress', p);
    try {
      const duck = project.settings.duckingEnabled ? await duckGainFunction(project) : undefined;
      return await runExport(project, job, { jobDir: jobDir(job.id), textAssets, signal: ac.signal, onProgress: report, duckGainAt: duck });
    } catch (e) {
      const msg = (e as Error).message;
      report({ jobId: job.id, status: msg === 'Cancelled' ? 'cancelled' : 'error', progress: 0, message: msg });
      throw e;
    } finally {
      exportAborts.delete(job.id);
    }
  });
  ipcMain.on('export:cancel', (_e, jobId: string) => exportAborts.get(jobId)?.abort());

  // ---------------------------------------------------------- AI
  ipcMain.handle('ai:complete', async (_e, req: AiRequest) => {
    const key = getApiKey();
    if (!key) throw new Error('No Anthropic API key set (Settings → AI).');
    return aiComplete(key, req, publicSettings().aiModel);
  });

  // ---------------------------------------------------------- settings
  ipcMain.handle('settings:get', async () => publicSettings());
  ipcMain.handle('settings:update', async (_e, patch: Record<string, unknown>) => {
    // the renderer may only change user preferences, never the key or the anonymous id
    const allowedKeys = ['sfxFolder', 'aiModel', 'lastExportDir', 'lastImportDir', 'customPresets', 'usageStatsOff', 'previewQuality'];
    const rest = Object.fromEntries(Object.entries(patch).filter(([k]) => allowedKeys.includes(k)));
    updateSettings(rest);
    return publicSettings();
  });
  ipcMain.handle('settings:setApiKey', async (_e, key: string | null) => {
    setApiKey(key && key.trim() ? key.trim() : null);
    return publicSettings();
  });
  ipcMain.handle('fonts:list', async () => listSystemFonts());
  ipcMain.handle('fonts:bundled', async () => listBundledFonts());
  ipcMain.handle('sfx:builtin', async () => builtinSfx());
  ipcMain.handle('app:checkUpdate', async () => checkForUpdate());
  ipcMain.handle('app:problemReport', async (_e, d: string, x: string) => createProblemReport(getWin(), String(d ?? '').slice(0, 5000), String(x ?? '').slice(0, 5000)));
  ipcMain.handle('app:info', async () => ({ version: app.getVersion(), updateRepo: appConfig().updateRepo }));
  ipcMain.handle('fonts:bundledBytes', async (_e, file: string) => readBundledFont(file));

  ipcMain.on('app:setTitle', (_e, t: string) => getWin()?.setTitle(t));
}
