// Background media work: thumbnails, filmstrips, proxies and waveform peaks.
// Everything is cached on disk by media key so re-opening a project is instant.
import fs from 'node:fs';
import path from 'node:path';
import type { WaveformData } from '../../shared/types';
import { cacheDir, mediaKey } from '../paths';
import { runFfmpeg, ffmpegError, CancelledError } from './run';

// ---------------------------------------------------------------- simple queue
type Task<T> = () => Promise<T>;

export class JobQueue {
  private running = 0;
  private q: { run: Task<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; key?: string }[] = [];
  constructor(private concurrency: number) {}
  push<T>(run: Task<T>, key?: string, front = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item = { run, resolve: resolve as (v: unknown) => void, reject, key };
      if (front) this.q.unshift(item);
      else this.q.push(item);
      this.pump();
    });
  }
  /** Move a queued task to the front (e.g. the user dropped this clip on the timeline). */
  prioritize(key: string): void {
    const i = this.q.findIndex((x) => x.key === key);
    if (i > 0) this.q.unshift(...this.q.splice(i, 1));
  }
  private pump(): void {
    while (this.running < this.concurrency && this.q.length) {
      const it = this.q.shift()!;
      this.running++;
      it.run()
        .then(it.resolve, it.reject)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

export const quickQueue = new JobQueue(2);
export const heavyQueue = new JobQueue(1);

// ---------------------------------------------------------------- thumbnails
export async function makeThumbnail(file: string, kind: 'video' | 'image', duration: number): Promise<string> {
  const out = path.join(cacheDir('thumbs'), mediaKey(file) + '.jpg');
  if (fs.existsSync(out)) return out;
  const tmp = out + '.tmp.jpg';
  const args =
    kind === 'video'
      ? ['-v', 'error', '-ss', String(Math.min(Math.max(0, duration * 0.1), Math.max(0, duration - 0.1))), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', '-y', tmp]
      : ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', "scale='min(320,iw)':-2", '-q:v', '4', '-y', tmp];
  const r = await quickQueue.push(() => runFfmpeg(args, { lowPriority: true }));
  if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(ffmpegError(r.stderr));
  fs.renameSync(tmp, out);
  return out;
}

// ---------------------------------------------------------------- waveform peaks
const PEAKS_PER_SEC = 100;

export async function makeWaveform(file: string): Promise<WaveformData> {
  const out = path.join(cacheDir('waveforms'), mediaKey(file) + '.json');
  if (fs.existsSync(out)) {
    try {
      return JSON.parse(fs.readFileSync(out, 'utf8'));
    } catch {
      /* regenerate */
    }
  }
  const SR = 4000;
  const r = await quickQueue.push(() =>
    runFfmpeg(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { captureStdout: true, lowPriority: true }),
  );
  if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
  const buf = r.stdout;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const per = SR / PEAKS_PER_SEC;
  const n = Math.ceil(samples.length / per);
  const peaks: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let mx = 0;
    const a = Math.floor(i * per);
    const b = Math.min(samples.length, Math.floor((i + 1) * per));
    for (let j = a; j < b; j++) {
      const v = Math.abs(samples[j]);
      if (v > mx) mx = v;
    }
    peaks[i] = Math.round(Math.min(1, mx) * 1000) / 1000;
  }
  const data: WaveformData = { peaksPerSec: PEAKS_PER_SEC, peaks, duration: samples.length / SR };
  fs.writeFileSync(out, JSON.stringify(data));
  return data;
}

/** Decode mono PCM at a given rate (used by beat detection / highlight analysis). */
export async function decodeMono(file: string, sampleRate: number, signal?: AbortSignal): Promise<Float32Array> {
  const r = await runFfmpeg(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], {
    captureStdout: true,
    lowPriority: true,
    signal,
  });
  if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
  const b = r.stdout;
  const copy = new Float32Array(Math.floor(b.byteLength / 4));
  copy.set(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + copy.length * 4)));
  return copy;
}

// ---------------------------------------------------------------- proxies + filmstrip
export interface ProxyResult {
  proxyPath: string;
  stripPath: string;
  stripInterval: number;
  stripCount: number;
}

/** Preview copy height: 540 = "Smooth" (fast on any PC), 1080 = "High" (sharp, default). */
export type ProxyHeight = 540 | 1080;

export function proxyPaths(file: string, height: ProxyHeight = 540): { proxy: string; strip: string; meta: string } {
  const k = mediaKey(file) + (height === 540 ? '' : `_${height}`);
  return {
    proxy: path.join(cacheDir('proxies'), k + '.mp4'),
    strip: path.join(cacheDir('strips'), k + '.jpg'),
    meta: path.join(cacheDir('strips'), k + '.json'),
  };
}

export function existingProxy(file: string, height: ProxyHeight = 540): ProxyResult | null {
  const p = proxyPaths(file, height);
  if (fs.existsSync(p.proxy) && fs.existsSync(p.meta)) {
    try {
      const m = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
      return { proxyPath: p.proxy, stripPath: p.strip, stripInterval: m.stripInterval, stripCount: m.stripCount };
    } catch {
      return null;
    }
  }
  return null;
}

const proxyAborts = new Map<string, AbortController>();

export function cancelProxy(file: string): void {
  proxyAborts.get(file)?.abort();
}

export function makeProxy(
  file: string,
  info: { duration: number; fps: number; width: number; height: number; hasAudio: boolean },
  onProgress: (k: number) => void,
  height: ProxyHeight = 540,
): Promise<ProxyResult> {
  const done = existingProxy(file, height);
  if (done) return Promise.resolve(done);
  return heavyQueue.push(async () => {
    const again = existingProxy(file, height);
    if (again) return again;
    onProgress(0); // tell the UI this clip's turn has started
    const p = proxyPaths(file, height);
    const fps = Math.min(60, Math.max(1, Math.round(info.fps || 30)));
    const stripInterval = Math.max(1, Math.ceil(info.duration / 200));
    const stripCount = Math.max(1, Math.ceil(info.duration / stripInterval));
    const tmp = p.proxy + '.part.mp4';
    const stripTmp = p.strip + '.part.jpg';
    const h = Math.min(height, info.height || height);
    const ac = new AbortController();
    proxyAborts.set(file, ac);
    const graph = `[0:v]split=2[a][b];[a]scale=-2:${h}:flags=bilinear,fps=${fps},format=yuv420p[p];[b]fps=1/${stripInterval},scale=-2:72,tile=${stripCount}x1[s]`;
    const args = [
      '-y',
      '-i', file,
      '-filter_complex', graph,
      '-map', '[p]',
      ...(info.hasAudio ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', height >= 1080 ? '20' : '26', '-tune', 'fastdecode',
      '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0',
      '-movflags', '+faststart', '-f', 'mp4', tmp,
      '-map', '[s]', '-frames:v', '1', '-q:v', '5', '-update', '1', '-f', 'image2', stripTmp,
    ];
    try {
      const r = await runFfmpeg(args, {
        lowPriority: true,
        signal: ac.signal,
        onProgress: (t) => onProgress(Math.min(1, t / Math.max(0.1, info.duration))),
      });
      if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
      fs.renameSync(tmp, p.proxy);
      if (fs.existsSync(stripTmp)) fs.renameSync(stripTmp, p.strip);
      fs.writeFileSync(p.meta, JSON.stringify({ stripInterval, stripCount }));
      return { proxyPath: p.proxy, stripPath: p.strip, stripInterval, stripCount };
    } catch (e) {
      for (const f of [tmp, stripTmp]) fs.rmSync(f, { force: true });
      throw e instanceof CancelledError ? e : e;
    } finally {
      proxyAborts.delete(file);
    }
  }, `${file}|${height}`);
}
