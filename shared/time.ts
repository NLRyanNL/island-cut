// Time helpers: frame quantization and timecode formatting.

export const EPS = 1e-6;

export function frameDur(fps: number): number {
  return 1 / fps;
}

/** Round a time to the nearest frame boundary. */
export function snapFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

export function floorFrame(t: number, fps: number): number {
  return Math.floor(t * fps + EPS) / fps;
}

export function toFrames(t: number, fps: number): number {
  return Math.round(t * fps);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** HH:MM:SS:FF timecode. */
export function timecode(t: number, fps: number): string {
  const neg = t < 0;
  const total = Math.round(Math.abs(t) * fps);
  const f = total % Math.round(fps);
  const s = Math.floor(total / Math.round(fps));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p(hh)}:${p(mm)}:${p(ss)}:${p(f)}`;
}

/** Short human duration, e.g. 1:05.3 */
export function shortDuration(t: number): string {
  if (!isFinite(t) || t <= 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

let idCounter = 0;
export function uid(prefix = ''): string {
  idCounter = (idCounter + 1) % 1679616;
  return (
    prefix +
    Date.now().toString(36) +
    Math.floor(Math.random() * 1e9).toString(36) +
    idCounter.toString(36)
  );
}
