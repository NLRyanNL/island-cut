import fs from 'node:fs';
import type { MediaKind, ProbeResult } from '../../shared/types';
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, extOf } from '../../shared/defaults';
import { runFfmpeg } from './run';

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  if (!b) return a || 0;
  return a / b;
}

export async function probeMedia(file: string): Promise<ProbeResult> {
  const fail = (error: string): ProbeResult => ({
    ok: false,
    error,
    duration: 0,
    width: 0,
    height: 0,
    fps: 0,
    hasVideo: false,
    hasAudio: false,
    audioChannels: 0,
    sampleRate: 0,
    codec: '',
    fileSize: 0,
    mtimeMs: 0,
  });
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return fail('File not found');
  }
  const ext = extOf(file);
  if (![...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS].includes(ext))
    return fail(`".${ext || '?'}" files are not supported. Use mp4/mov/mkv video, mp3/wav/ogg/m4a audio or png/jpg images.`);
  const r = await runFfmpeg(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { probe: true, captureStdout: true });
  if (r.code !== 0) return fail(`Could not read this file (${r.stderr.trim().split('\n').pop() || 'unknown format'}). It may be damaged or still being recorded.`);
  interface FfStream {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    duration?: string;
    channels?: number;
    sample_rate?: string;
    disposition?: { attached_pic?: number };
  }
  let j: { streams?: FfStream[]; format?: { duration?: string } };
  try {
    j = JSON.parse(r.stdout.toString() || '{}');
  } catch {
    return fail('Could not parse media information');
  }
  const streams = j.streams ?? [];
  const isImageExt = IMAGE_EXTS.includes(ext);
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0;
  let kind: MediaKind;
  if (isImageExt) kind = 'image';
  else if (v && !AUDIO_EXTS.includes(ext)) kind = 'video';
  else if (a) kind = 'audio';
  else return fail('This file has no usable video or audio stream.');
  if (kind === 'video' && duration <= 0) return fail('Video has no duration (is the recording finished?)');
  const fps = v ? parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) : 0;
  return {
    ok: true,
    kind,
    duration: kind === 'image' ? 0 : duration,
    width: Number(v?.width ?? 0),
    height: Number(v?.height ?? 0),
    fps: kind === 'video' ? (fps > 0 && fps < 1000 ? fps : 30) : 0,
    hasVideo: kind !== 'audio',
    hasAudio: !!a && kind !== 'image',
    audioChannels: Number(a?.channels ?? 0),
    sampleRate: Number(a?.sample_rate ?? 0),
    codec: String(v?.codec_name ?? a?.codec_name ?? ''),
    fileSize: st.size,
    mtimeMs: st.mtimeMs,
  };
}
