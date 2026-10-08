// Helpers for choosing which part of a song a trailer uses.

/** Loudness envelope (one value per second) from waveform peaks. */
export function loudnessPerSecond(peaks: number[], peaksPerSec: number): number[] {
  const n = Math.ceil(peaks.length / Math.max(1, peaksPerSec));
  const out: number[] = [];
  for (let s = 0; s < n; s++) {
    let sum = 0;
    let c = 0;
    for (let i = Math.floor(s * peaksPerSec); i < Math.min(peaks.length, Math.floor((s + 1) * peaksPerSec)); i++) {
      sum += peaks[i] * peaks[i];
      c++;
    }
    out.push(c ? Math.sqrt(sum / c) : 0);
  }
  return out;
}

/**
 * Where the quiet intro ends: the first second whose loudness reaches half of the song's
 * typical loud level (90th percentile), minus a short lead-in. 0 if the song starts loud.
 */
export function skipIntroOffset(peaks: number[], peaksPerSec: number): number {
  const env = loudnessPerSecond(peaks, peaksPerSec);
  if (env.length < 4) return 0;
  const sorted = [...env].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)];
  if (loud <= 0) return 0;
  const i = env.findIndex((v) => v >= loud * 0.5);
  return Math.max(0, i - 0.5);
}

/** Clamp a start offset so the trailer still fits inside the song when possible. */
export function clampMusicStart(start: number, songDuration: number, trailerDuration: number): number {
  const maxStart = Math.max(0, songDuration - trailerDuration);
  return Math.round(Math.min(Math.max(0, start), maxStart) * 10) / 10;
}
