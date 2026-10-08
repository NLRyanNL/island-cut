import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { MediaItem, Project } from '../shared/types';
import { probeMedia } from '../electron/ffmpeg/probe';
import { basename } from '../shared/defaults';
import { uid } from '../shared/time';
import { ffmpegPath, ffprobePath } from '../electron/ffmpeg/binaries';

export const MEDIA_DIR = process.env.UTS_TEST_MEDIA ?? path.join(os.tmpdir(), 'uts-test-media');

/** Generate small synthetic test media with FFmpeg (cached). */
export function ensureTestMedia(): Record<string, string> {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const ff = ffmpegPath();
  const files: Record<string, [string, string[]]> = {
    clipA: ['clipA.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-shortest']],
    clipB: ['clipB.mkv', ['-f', 'lavfi', '-i', 'color=c=0x2060ff:s=1920x1080:r=30:d=6,drawbox=x=100:y=100:w=200:h=200:c=yellow:t=fill', '-f', 'lavfi', '-i', 'sine=f=880:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest']],
    green: ['green.mp4', ['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-an']],
    music: ['music.mp3', ['-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*110*t)*exp(-6*mod(t,0.5))':s=44100:d=12", '-ac', '2']],
    logo: ['logo.png', ['-f', 'lavfi', '-i', 'color=c=red:s=400x200', '-frames:v', '1']],
  };
  const out: Record<string, string> = {};
  for (const [key, [name, args]] of Object.entries(files)) {
    const p = path.join(MEDIA_DIR, name);
    if (!fs.existsSync(p)) execFileSync(ff, ['-v', 'error', '-y', ...args, p]);
    out[key] = p;
  }
  return out;
}

export async function addMedia(p: Project, file: string, folder: MediaItem['folder'] = 'media'): Promise<MediaItem> {
  const r = await probeMedia(file);
  if (!r.ok) throw new Error(r.error);
  const m: MediaItem = {
    id: uid('med_'),
    kind: r.kind!,
    name: basename(file),
    path: file,
    folder,
    duration: r.duration,
    width: r.width,
    height: r.height,
    fps: r.fps,
    hasVideo: r.hasVideo,
    hasAudio: r.hasAudio,
    audioChannels: r.audioChannels,
    sampleRate: r.sampleRate,
    codec: r.codec,
    fileSize: r.fileSize,
    mtimeMs: r.mtimeMs,
  };
  p.media[m.id] = m;
  return m;
}

export function probeJson(file: string): { duration: number; streams: { codec_type: string; width?: number; height?: number; nb_frames?: string; r_frame_rate?: string }[] } {
  const o = execFileSync(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', file]).toString();
  const j = JSON.parse(o);
  return { duration: Number(j.format.duration), streams: j.streams };
}

/** RGB of a pixel at time t (seconds) of a video file. */
export function pixelAt(file: string, t: number, x: number, y: number): [number, number, number] {
  const buf = execFileSync(ffmpegPath(), ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x - (x % 2)}:${y - (y % 2)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [buf[0], buf[1], buf[2]];
}

/** Mean volume (dB) of an audio window. */
export function volumeAt(file: string, t: number, d: number): number {
  const res = spawnSync(ffmpegPath(), ['-v', 'info', '-ss', String(t), '-t', String(d), '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(res.stderr.toString());
  if (!m) return -Infinity;
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

export function tmpOut(name: string): string {
  const d = path.join(os.tmpdir(), 'uts-test-out');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
}

export const near = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
