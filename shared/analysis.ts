// Footage analysis for Auto Trailer (pure functions, run in a worker thread).
// Input: low-res grayscale frames + mono audio. Output: per-second scores and HUD boxes.

export interface HudBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FootageAnalysis {
  duration: number;
  /** one value per second */
  motion: number[]; // 0..1 amount of movement
  brightness: number[]; // 0..1 mean luma
  detail: number[]; // 0..1 spatial detail (low = flat menu / loading screen / black)
  sceneCut: number[]; // 0/1 hard cut inside this second
  loudness: number[]; // 0..1 (RMS mapped from -60..0 dBFS)
  peaks: number[]; // 0..1 loud transient (impact / explosion) strength
  gunfire: number[]; // 0..1 likelihood of active gunfire
  hud: number[]; // 0..1 how strongly the static HUD is visible in this second
  hudBoxes: HudBox[]; // normalized boxes of the static HUD
  hudScore: number; // 0..1 overall HUD coverage
}

export interface FrameInput {
  frames: Uint8Array; // gray, w*h per frame
  w: number;
  h: number;
  fps: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

// ----------------------------------------------------------------------------- video
interface VideoStats {
  diff: Float32Array; // per frame (vs previous)
  mean: Float32Array;
  std: Float32Array;
}

function frameStats(fi: FrameInput): VideoStats {
  const { frames, w, h } = fi;
  const n = Math.floor(frames.length / (w * h));
  const px = w * h;
  const diff = new Float32Array(n);
  const mean = new Float32Array(n);
  const std = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const o = f * px;
    let s = 0;
    let s2 = 0;
    let d = 0;
    for (let i = 0; i < px; i++) {
      const v = frames[o + i];
      s += v;
      s2 += v * v;
      if (f > 0) d += Math.abs(v - frames[o - px + i]);
    }
    const m = s / px;
    mean[f] = m;
    std[f] = Math.sqrt(Math.max(0, s2 / px - m * m));
    diff[f] = f > 0 ? d / px : 0;
  }
  return { diff, mean, std };
}

const CX = 16;
const CY = 9;

/** Static + edge-rich pixel density per grid cell for frames [f0, f1). Null if the shot is too static to judge. */
function hudCells(fi: FrameInput, f0: number, f1: number): { cells: Float32Array; meanImg: Float32Array; candidate: Uint8Array } | null {
  const { frames, w, h } = fi;
  const px = w * h;
  const n = f1 - f0;
  if (n < 6) return null;
  const meanImg = new Float32Array(px);
  const sq = new Float32Array(px);
  for (let f = f0; f < f1; f++) {
    const o = f * px;
    for (let i = 0; i < px; i++) {
      const v = frames[o + i];
      meanImg[i] += v;
      sq[i] += v * v;
    }
  }
  const pixStd = new Float32Array(px);
  let globalStd = 0;
  for (let i = 0; i < px; i++) {
    meanImg[i] /= n;
    pixStd[i] = Math.sqrt(Math.max(0, sq[i] / n - meanImg[i] * meanImg[i]));
    globalStd += pixStd[i];
  }
  globalStd /= px;
  if (globalStd < 6) return null; // camera barely moves: cannot separate HUD from scenery
  const staticThr = Math.max(4, globalStd * 0.25);
  const candidate = new Uint8Array(px);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (pixStd[i] > staticThr) continue;
      const gx = meanImg[i + 1] - meanImg[i - 1];
      const gy = meanImg[i + w] - meanImg[i - w];
      if (Math.hypot(gx, gy) > 18) candidate[i] = 1;
    }
  const cells = new Float32Array(CX * CY);
  const cw = w / CX;
  const ch = h / CY;
  for (let cy = 0; cy < CY; cy++)
    for (let cx = 0; cx < CX; cx++) {
      let c = 0;
      let tot = 0;
      for (let y = Math.floor(cy * ch); y < Math.floor((cy + 1) * ch); y++)
        for (let x = Math.floor(cx * cw); x < Math.floor((cx + 1) * cw); x++) {
          tot++;
          c += candidate[y * w + x];
        }
      cells[cy * CX + cx] = tot ? c / tot : 0;
    }
  return { cells, meanImg, candidate };
}

function cellsToBoxes(cell: Uint8Array): HudBox[] {
  const seen = new Uint8Array(CX * CY);
  const boxes: HudBox[] = [];
  for (let i = 0; i < CX * CY; i++) {
    if (!cell[i] || seen[i]) continue;
    let minx = CX, miny = CY, maxx = -1, maxy = -1, count = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % CX;
      const y = Math.floor(k / CX);
      count++;
      minx = Math.min(minx, x);
      maxx = Math.max(maxx, x);
      miny = Math.min(miny, y);
      maxy = Math.max(maxy, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= CX || ny >= CY) continue;
        const nk = ny * CX + nx;
        if (cell[nk] && !seen[nk]) {
          seen[nk] = 1;
          stack.push(nk);
        }
      }
    }
    const b = { x: minx / CX, y: miny / CY, w: (maxx - minx + 1) / CX, h: (maxy - miny + 1) / CY };
    const nearEdge = b.x < 0.3 || b.y < 0.3 || b.x + b.w > 0.7 || b.y + b.h > 0.7;
    if (b.w * b.h < 0.25 && (nearEdge || count <= 2)) boxes.push(b);
  }
  return boxes;
}

/**
 * Find static, edge-rich regions (HUD overlays: minimap, health, inventory, crosshair).
 * Runs on 4-second windows so clips where the HUD is only sometimes visible are handled,
 * and reports per-window HUD presence.
 */
export function detectHud(fi: FrameInput): { boxes: HudBox[]; score: number; windowPresence: { f0: number; f1: number; p: number }[] } {
  const px = fi.w * fi.h;
  const n = Math.floor(fi.frames.length / px);
  const win = Math.max(8, Math.round(fi.fps * 4));
  const step = Math.max(4, Math.round(win / 2));
  const windows: { f0: number; f1: number; cells: Float32Array }[] = [];
  for (let f0 = 0; f0 < n; f0 += step) {
    const f1 = Math.min(n, f0 + win);
    if (f1 - f0 < Math.min(6, n)) break;
    const r = hudCells(fi, f0, f1);
    if (r) windows.push({ f0, f1, cells: r.cells });
    if (f1 === n) break;
  }
  if (!windows.length) return { boxes: [], score: 0, windowPresence: [] };
  const THR = 0.06;
  const freq = new Float32Array(CX * CY);
  for (const w of windows) for (let i = 0; i < CX * CY; i++) if (w.cells[i] > THR) freq[i] += 1 / windows.length;
  const global = new Uint8Array(CX * CY);
  for (let i = 0; i < CX * CY; i++) if (freq[i] >= 0.25) global[i] = 1;
  const boxes = cellsToBoxes(global);
  // keep only cells that belong to accepted boxes
  const inBox = new Uint8Array(CX * CY);
  for (const b of boxes)
    for (let cy = Math.round(b.y * CY); cy < Math.round((b.y + b.h) * CY); cy++)
      for (let cx = Math.round(b.x * CX); cx < Math.round((b.x + b.w) * CX); cx++) inBox[cy * CX + cx] = 1;
  const hudIdx = [...inBox.keys()].filter((i) => inBox[i]);
  const windowPresence = windows.map((w) => ({
    f0: w.f0,
    f1: w.f1,
    p: hudIdx.length ? hudIdx.filter((i) => w.cells[i] > THR).length / hudIdx.length : 0,
  }));
  const score = clamp01(boxes.reduce((a, b) => a + b.w * b.h, 0) * 4);
  return { boxes, score, windowPresence };
}

// ----------------------------------------------------------------------------- audio
interface AudioScores {
  loudness: number[];
  peaks: number[];
  gunfire: number[];
}

export function audioScores(samples: Float32Array, sr: number, seconds: number): AudioScores {
  const loudness: number[] = new Array(seconds).fill(0);
  const peaks: number[] = new Array(seconds).fill(0);
  const gunfire: number[] = new Array(seconds).fill(0);
  if (!samples.length) return { loudness, peaks, gunfire };
  const hop = Math.round(sr * 0.01); // 10 ms energy frames
  const nE = Math.floor(samples.length / hop);
  const eDb = new Float32Array(nE);
  for (let i = 0; i < nE; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += samples[j] * samples[j];
    eDb[i] = 10 * Math.log10(s / hop + 1e-10);
  }
  // per second RMS loudness
  for (let sec = 0; sec < seconds; sec++) {
    const a = sec * 100;
    const b = Math.min(nE, a + 100);
    if (b <= a) continue;
    let p = 0;
    for (let i = a; i < b; i++) p += Math.pow(10, eDb[i] / 10);
    const db = 10 * Math.log10(p / (b - a) + 1e-10);
    loudness[sec] = clamp01((db + 60) / 60);
  }
  // transient detection: sudden energy rise that decays quickly (gunshots / impacts)
  const imp: number[] = []; // impulsive transients (fast decay)
  for (let i = 4; i < nE - 8; i++) {
    const prev = (eDb[i - 4] + eDb[i - 3] + eDb[i - 2]) / 3;
    const rise = eDb[i] - prev;
    if (rise < 9 || eDb[i] < -32) continue;
    if (eDb[i] < eDb[i - 1] || eDb[i] < eDb[i + 1]) continue; // local max
    const after = (eDb[i + 5] + eDb[i + 6] + eDb[i + 7]) / 3;
    const decay = eDb[i] - after;
    const sec = Math.floor(i / 100);
    if (sec < seconds) peaks[sec] = Math.max(peaks[sec], clamp01((eDb[i] + 30) / 30) * clamp01(rise / 20));
    if (decay > 6) imp.push(i);
  }
  // gunfire: several impulsive transients within a second, ideally at a regular rate
  for (let sec = 0; sec < seconds; sec++) {
    const inSec = imp.filter((i) => i >= sec * 100 - 50 && i < (sec + 1) * 100 + 50);
    if (inSec.length < 2) continue;
    const gaps = inSec.slice(1).map((v, k) => v - inSec[k]);
    const g = median(gaps);
    const regular = gaps.filter((x) => Math.abs(x - g) <= Math.max(3, g * 0.35)).length / gaps.length;
    const rate = inSec.length / 2; // per second over the 2s window
    gunfire[sec] = clamp01((rate - 0.8) / 3) * (0.5 + 0.5 * regular);
  }
  return { loudness, peaks, gunfire };
}

// ----------------------------------------------------------------------------- combined
export function analyzeFootage(fi: FrameInput | null, audio: Float32Array | null, sr: number, duration: number): FootageAnalysis {
  const seconds = Math.max(1, Math.ceil(duration));
  const motion: number[] = new Array(seconds).fill(0);
  const brightness: number[] = new Array(seconds).fill(0);
  const detail: number[] = new Array(seconds).fill(0);
  const sceneCut: number[] = new Array(seconds).fill(0);
  const hud: number[] = new Array(seconds).fill(0);
  let hudBoxes: HudBox[] = [];
  let hudScore = 0;
  if (fi && fi.frames.length >= fi.w * fi.h) {
    const st = frameStats(fi);
    const n = st.diff.length;
    const medDiff = median(Array.from(st.diff).filter((d) => d > 0)) || 1;
    for (let sec = 0; sec < seconds; sec++) {
      const a = Math.floor(sec * fi.fps);
      const b = Math.min(n, Math.floor((sec + 1) * fi.fps));
      if (b <= a) continue;
      let dm = 0;
      let bm = 0;
      let sm = 0;
      let cut = 0;
      for (let f = a; f < b; f++) {
        dm += st.diff[f];
        bm += st.mean[f];
        sm += st.std[f];
        if (f > 0 && st.diff[f] > Math.max(28, medDiff * 4)) cut = 1;
      }
      const k = b - a;
      motion[sec] = clamp01(dm / k / 30);
      brightness[sec] = clamp01(bm / k / 255);
      detail[sec] = clamp01(sm / k / 60);
      sceneCut[sec] = cut;
    }
    const hd = detectHud(fi);
    hudBoxes = hd.boxes;
    hudScore = hd.score;
    for (let sec = 0; sec < seconds; sec++) {
      const f = (sec + 0.5) * fi.fps;
      const ws = hd.windowPresence.filter((w) => f >= w.f0 && f < w.f1);
      hud[sec] = ws.length ? clamp01(Math.max(...ws.map((w) => w.p)) * 1.2) : hudBoxes.length ? 0.5 : 0;
    }
  }
  const sr2 = sr || 8000;
  const au = audio ? audioScores(audio, sr2, seconds) : { loudness: new Array(seconds).fill(0), peaks: new Array(seconds).fill(0), gunfire: new Array(seconds).fill(0) };
  return { duration, motion, brightness, detail, sceneCut, loudness: au.loudness, peaks: au.peaks, gunfire: au.gunfire, hud, hudBoxes, hudScore };
}
