import fs from 'node:fs';
import path from 'node:path';
import type { BeatAnalysis } from '../../shared/types';
import { detectBeats } from '../../shared/beatDetect';
import { cacheDir, mediaKey } from '../paths';
import { decodeMono, quickQueue } from '../ffmpeg/mediaJobs';
import { runInWorker } from '../workerPool';

export async function detectBeatsForFile(file: string): Promise<BeatAnalysis> {
  const out = path.join(cacheDir('analysis'), mediaKey(file) + '.beats.json');
  if (fs.existsSync(out)) {
    try {
      return JSON.parse(fs.readFileSync(out, 'utf8'));
    } catch {
      /* recompute */
    }
  }
  const sr = 22050;
  const samples = await quickQueue.push(() => decodeMono(file, sr));
  // DSP runs in a worker thread so the app stays responsive on long songs.
  const res = await runInWorker<BeatAnalysis>('beats', { samples, sampleRate: sr }, () => detectBeats(samples, sr));
  fs.writeFileSync(out, JSON.stringify(res));
  return res;
}
