// Main-process side of the built-in self test (UTS_SELFTEST=1) + a persistent log file.
import { app, ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg, ffmpegError } from './ffmpeg/run';
import { allowPath } from './ipc';

let logFile = '';

export function logLine(line: string): void {
  try {
    if (!logFile) {
      const dir = process.env.UTS_LOG_DIR || path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'app.log');
      // keep the previous session's log (useful for "Report a problem" after a crash)
      try {
        if (fs.existsSync(logFile)) fs.renameSync(logFile, path.join(dir, 'app.prev.log'));
      } catch {
        /* ignore */
      }
      fs.writeFileSync(logFile, `--- ${new Date().toISOString()} IslandCut ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform})\n`);
    }
    fs.appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} ${line}\n`);
  } catch {
    /* ignore */
  }
}

/** The folder that holds app.log / app.prev.log. */
export function logDir(): string {
  return logFile ? path.dirname(logFile) : process.env.UTS_LOG_DIR || path.join(app.getPath('userData'), 'logs');
}

export function attachLogging(win: BrowserWindow): void {
  win.webContents.on('console-message', (e) => {
    const ev = e as unknown as { level?: string | number; message?: string; lineNumber?: number; sourceId?: string };
    const level = String(ev.level ?? '');
    if (level === 'error' || level === 'warning' || level === '2' || level === '3') logLine(`[renderer ${level}] ${ev.message} (${ev.sourceId ?? ''}:${ev.lineNumber ?? ''})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => logLine(`[renderer gone] ${d.reason} ${d.exitCode}`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logLine(`[did-fail-load] ${code} ${desc} ${url}`));
}

export function registerSelftest(): void {
  process.on('uncaughtException', (e) => logLine(`[main uncaught] ${e.stack ?? e}`));
  process.on('unhandledRejection', (e) => logLine(`[main unhandled] ${(e as Error)?.stack ?? e}`));
  ipcMain.handle('selftest:media', async () => {
    const dir = path.join(os.tmpdir(), 'uts-selftest');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    allowPath(dir);
    const jobs: Record<string, [string, string[]]> = {
      clipA: ['clipA.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest']],
      clipB: ['clipB.mkv', ['-f', 'lavfi', '-i', 'mandelbrot=s=2560x1440:r=60,trim=duration=4', '-f', 'lavfi', '-i', 'sine=f=660:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest']],
      music: ['music.mp3', ['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*110*t)*exp(-6*mod(t,0.5))':s=44100:d=12", '-ac', '2']],
      logo: ['logo.png', ['-f', 'lavfi', '-i', 'color=c=orange:s=800x600', '-frames:v', '1']],
    };
    const files: Record<string, string> = {};
    for (const [k, [name, args]] of Object.entries(jobs)) {
      const out = path.join(dir, name);
      const r = await runFfmpeg(['-v', 'error', '-y', ...args, out]);
      if (r.code !== 0) throw new Error(`${name}: ${ffmpegError(r.stderr)}`);
      files[k] = out;
      allowPath(out);
    }
    return { dir, files };
  });
  ipcMain.handle('selftest:done', async (_e, report: { ok: boolean }) => {
    const out = process.env.UTS_SELFTEST_REPORT || path.join(app.getPath('userData'), 'selftest-report.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    logLine(`[selftest] ${report.ok ? 'PASSED' : 'FAILED'} → ${out}`);
    setTimeout(() => app.exit(report.ok ? 0 : 1), 300);
  });
}
