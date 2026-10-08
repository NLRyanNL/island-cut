import type { Project, WaveformData } from '../../shared/types';
import { computeDuckIntervals, duckGainAt } from '../../shared/ducking';
import { makeWaveform } from '../ffmpeg/mediaJobs';

export async function duckGainFunction(p: Project): Promise<(t: number) => number> {
  const wfs: Record<string, WaveformData | undefined> = {};
  for (const m of Object.values(p.media)) {
    if (!m.hasAudio) continue;
    try {
      wfs[m.path] = await makeWaveform(m.path);
    } catch {
      /* ignore */
    }
  }
  const iv = computeDuckIntervals(p, wfs);
  return (t: number) => duckGainAt(p, iv, t);
}
