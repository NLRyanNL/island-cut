// Decodes low-res frames + audio with FFmpeg, runs the analysis DSP in the worker thread, caches results.
import fs from 'node:fs';
import path from 'node:path';
import type { MediaItem } from '../../shared/types';
import type { FrameSample, MediaAnalysis } from '../../shared/api';
import { analyzeFootage, FootageAnalysis } from '../../shared/analysis';
import { cacheDir, mediaKey } from '../paths';
import { runFfmpeg, ffmpegError } from '../ffmpeg/run';
import { decodeMono, existingProxy, heavyQueue } from '../ffmpeg/mediaJobs';
import { runInWorker } from '../workerPool';

const VERSION = 3;

export async function analyzeMediaFile(m: MediaItem): Promise<MediaAnalysis> {
  const out = path.join(cacheDir('analysis'), `${mediaKey(m.path)}.footage.v${VERSION}.json`);
  if (fs.existsSync(out)) {
    try {
      return JSON.parse(fs.readFileSync(out, 'utf8'));
    } catch {
      /* recompute */
    }
  }
  const src = existingProxy(m.path)?.proxyPath ?? m.path; // proxies decode much faster
  const w = 160;
  const h = 90;
  const fps = m.duration > 900 ? 2 : 4;
  const result = await heavyQueue.push(async () => {
    let frames: Uint8Array | null = null;
    if (m.hasVideo && m.kind === 'video') {
      const r = await runFfmpeg(['-v', 'error', '-i', src, '-an', '-vf', `fps=${fps},scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-'], {
        captureStdout: true,
        lowPriority: true,
      });
      if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
      frames = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength);
    }
    let audio: Float32Array | null = null;
    if (m.hasAudio) {
      try {
        audio = await decodeMono(src, 8000);
      } catch {
        audio = null;
      }
    }
    const fi = frames ? { frames, w, h, fps } : null;
    return runInWorker<FootageAnalysis>('analyze', { fi, audio, sr: 8000, duration: m.duration }, () => analyzeFootage(fi, audio, 8000, m.duration));
  });
  const res: MediaAnalysis = { ...result, mediaId: m.id };
  fs.writeFileSync(out, JSON.stringify(res));
  return res;
}

/** Grab JPEG frames (base64) at the given source times, e.g. for AI shot checks and thumbnails. */
export async function sampleFrames(file: string, times: number[], width: number): Promise<FrameSample[]> {
  const src = existingProxy(file)?.proxyPath ?? file;
  const out: FrameSample[] = [];
  for (const t of times) {
    const r = await runFfmpeg(['-v', 'error', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], {
      captureStdout: true,
    });
    if (r.code === 0 && r.stdout.length) out.push({ time: t, jpegBase64: r.stdout.toString('base64') });
  }
  return out;
}
