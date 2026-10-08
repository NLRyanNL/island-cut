// Locates the bundled FFmpeg / FFprobe binaries (ffmpeg-static / ffprobe-static).
// In a packaged app the binaries live in app.asar.unpacked, so the path is rewritten.
import fs from 'node:fs';

function fixAsar(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

let ffmpeg: string | null = null;
let ffprobe: string | null = null;

export function ffmpegPath(): string {
  if (ffmpeg) return ffmpeg;
  const env = process.env.UTS_FFMPEG_PATH;
  if (env && fs.existsSync(env)) return (ffmpeg = env);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p: string | null = require('ffmpeg-static');
  if (!p) throw new Error('ffmpeg-static did not provide a binary for this platform. Run "npm install" again.');
  ffmpeg = fixAsar(p);
  if (!fs.existsSync(ffmpeg)) throw new Error(`FFmpeg binary not found at ${ffmpeg}. Try "npm rebuild ffmpeg-static".`);
  return ffmpeg;
}

export function ffprobePath(): string {
  if (ffprobe) return ffprobe;
  const env = process.env.UTS_FFPROBE_PATH;
  if (env && fs.existsSync(env)) return (ffprobe = env);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod: { path: string } = require('ffprobe-static');
  ffprobe = fixAsar(mod.path);
  if (!fs.existsSync(ffprobe)) throw new Error(`FFprobe binary not found at ${ffprobe}. Try "npm rebuild ffprobe-static".`);
  return ffprobe;
}
