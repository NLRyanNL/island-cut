// Spawning FFmpeg/FFprobe as separate processes (never blocks the UI) with progress and cancel.
import { spawn, ChildProcess } from 'node:child_process';
import { ffmpegPath, ffprobePath } from './binaries';

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

export interface RunOptions {
  cwd?: string;
  /** Called with output time (seconds) parsed from -progress pipe:1 */
  onProgress?: (outTimeSec: number, speed: number, fps: number) => void;
  signal?: AbortSignal;
  /** Collect stdout as a Buffer (for raw PCM / image pipes). */
  captureStdout?: boolean;
  /** Use FFprobe instead of FFmpeg. */
  probe?: boolean;
  /** Low process priority for background jobs (proxies, analysis). */
  lowPriority?: boolean;
}

export interface RunResult {
  code: number;
  stderr: string;
  stdout: Buffer;
}

const running = new Set<ChildProcess>();

export function killAll(): void {
  for (const c of running) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  running.clear();
}

export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const bin = opts.probe ? ffprobePath() : ffmpegPath();
    const fullArgs = opts.probe ? args : ['-hide_banner', '-nostdin', ...(opts.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
    const child = spawn(bin, fullArgs, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    if (opts.lowPriority && child.pid) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const os = require('node:os');
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* not fatal */
      }
    }
    let stderr = '';
    const outChunks: Buffer[] = [];
    let progBuf = '';
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.stdout.on('data', (d: Buffer) => {
      if (opts.captureStdout) {
        outChunks.push(d);
        return;
      }
      if (!opts.onProgress) return;
      progBuf += d.toString();
      let idx: number;
      let outTime = -1;
      let speed = 0;
      let fps = 0;
      while ((idx = progBuf.indexOf('\n')) >= 0) {
        const line = progBuf.slice(0, idx).trim();
        progBuf = progBuf.slice(idx + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const n = Number(val);
          if (isFinite(n)) outTime = n / 1e6;
        } else if (key === 'speed') speed = parseFloat(val) || 0;
        else if (key === 'fps') fps = parseFloat(val) || 0;
        else if (key === 'progress' && outTime >= 0) opts.onProgress(outTime, speed, fps);
      }
    });
    child.on('error', (e) => {
      running.delete(child);
      reject(e);
    });
    child.on('close', (code) => {
      running.delete(child);
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) return reject(new CancelledError());
      resolve({ code: code ?? -1, stderr, stdout: Buffer.concat(outChunks) });
    });
  });
}

/** Extract a short readable error from FFmpeg's stderr. */
export function ffmpegError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(frame=|size=|Press \[q\]|\s*Stream #|\s*Metadata:|\s*Duration:|Input #|Output #|configuration:|lib\w+\s+\d)/.test(l));
  const important = lines.filter((l) => /error|invalid|no such|not found|failed|unable|cannot|could not|unknown|denied|does not/i.test(l));
  const pick = (important.length ? important : lines).slice(-4);
  return pick.join('\n') || 'FFmpeg failed';
}
