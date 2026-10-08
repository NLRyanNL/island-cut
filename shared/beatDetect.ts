// Beat detection: spectral-flux onset envelope -> tempo via autocorrelation ->
// dynamic-programming beat tracking (Ellis 2007) -> downbeats assuming 4/4.
import type { BeatAnalysis } from './types';

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface OnsetEnvelope {
  env: Float64Array;
  rate: number; // frames per second
  /** seconds to add to frame times (analysis window latency) */
  offset: number;
}

export function onsetEnvelope(samples: Float32Array, sr: number): OnsetEnvelope {
  const N = 1024;
  const hop = 256;
  const frames = Math.max(0, Math.floor((samples.length - N) / hop) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const bins = N / 2;
  let prev = new Float64Array(bins);
  const env = new Float64Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  // only use bins up to ~8 kHz
  const maxBin = Math.min(bins, Math.floor((8000 / sr) * N));
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const cur = new Float64Array(bins);
    let flux = 0;
    for (let k = 1; k < maxBin; k++) {
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      const d = mag - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev = cur;
  }
  // remove slow trend (moving average over ~0.5s) and rectify
  const rate = sr / hop;
  const w = Math.max(1, Math.round(rate * 0.25));
  const out = new Float64Array(frames);
  let acc = 0;
  const pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) {
    acc += env[i];
    pre[i + 1] = acc;
  }
  let mx = 0;
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(frames, i + w + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    out[i] = Math.max(0, env[i] - mean);
    if (out[i] > mx) mx = out[i];
  }
  if (mx > 0) for (let i = 0; i < frames; i++) out[i] /= mx;
  return { env: out, rate, offset: (0.75 * N) / sr };
}

export function estimateTempo(o: OnsetEnvelope, minBpm = 70, maxBpm = 190): { bpm: number; period: number } {
  const { env, rate } = o;
  const minLag = Math.floor((60 / maxBpm) * rate);
  const maxLag = Math.ceil((60 / minBpm) * rate);
  let best = -Infinity;
  let bestLag = Math.round((60 / 120) * rate);
  const n = env.length;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    s /= n - lag;
    // log-gaussian prior around 120 BPM
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = s * prior;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  // parabolic refinement
  return { bpm: (60 * rate) / bestLag, period: bestLag };
}

export function trackBeats(o: OnsetEnvelope, period: number, tightness = 100): number[] {
  const { env, rate } = o;
  const n = env.length;
  if (n === 0) return [];
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let bestV = 0;
    let bestI = -1;
    const lo = Math.max(0, t - Math.round(2 * period));
    const hi = t - Math.round(period / 2);
    for (let pidx = lo; pidx <= hi; pidx++) {
      const x = Math.log((t - pidx) / period);
      const v = score[pidx] - tightness * x * x;
      if (v > bestV || bestI < 0) {
        bestV = v;
        bestI = pidx;
      }
    }
    score[t] = env[t] + (bestI >= 0 ? Math.max(0, bestV) : 0);
    back[t] = bestI >= 0 && bestV > 0 ? bestI : -1;
  }
  // start from the best score in the last period
  let t = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) {
    if (score[i] > bestEnd) {
      bestEnd = score[i];
      t = i;
    }
  }
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t / rate);
    t = back[t];
  }
  beats.reverse();
  return beats;
}

export function detectBeats(samples: Float32Array, sr: number): BeatAnalysis {
  const o = onsetEnvelope(samples, sr);
  if (o.env.length < o.rate * 2) return { bpm: 0, beats: [], downbeats: [] };
  const { bpm, period } = estimateTempo(o);
  let beats = trackBeats(o, period);
  // Fill large gaps (quiet intros) with the tempo grid, and drop beats before the music starts.
  const first = beats.findIndex((b) => o.env[Math.round(b * o.rate)] > 0.02);
  if (first > 0) beats = beats.slice(first);
  // downbeats: choose the phase (0..3) with the most onset energy
  let bestPhase = 0;
  let bestE = -1;
  for (let ph = 0; ph < 4; ph++) {
    let e = 0;
    for (let i = ph; i < beats.length; i += 4) e += o.env[Math.min(o.env.length - 1, Math.round(beats[i] * o.rate))];
    if (e > bestE) {
      bestE = e;
      bestPhase = ph;
    }
  }
  // refine tempo with a least-squares fit of beat index vs. time
  let refined = bpm;
  if (beats.length > 8) {
    const n = beats.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += beats[i];
      sxx += i * i;
      sxy += i * beats[i];
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    if (slope > 0) refined = 60 / slope;
  }
  const shifted = beats.map((b) => Math.round((b + o.offset) * 1000) / 1000);
  const downbeats = shifted.filter((_, i) => i % 4 === bestPhase);
  return { bpm: Math.round(refined * 10) / 10, beats: shifted, downbeats };
}
