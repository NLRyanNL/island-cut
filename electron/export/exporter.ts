// Runs one export job: builds the filter graph, optionally measures loudness (pass 1),
// then renders with FFmpeg in a child process. No Electron imports, so it is unit-testable.
import fs from 'node:fs';
import path from 'node:path';
import type { ExportJob, JobProgress, MediaItem, Project } from '../../shared/types';
import { buildGraph, LoudnormMeasure, TextAsset } from '../../shared/render/buildGraph';
import type { CubeLut } from '../../shared/color';
import { parseCube } from '../../shared/color';
import { runFfmpeg, ffmpegError, CancelledError } from '../ffmpeg/run';

export interface ExportContext {
  /** Directory where the job's temporary files (filter script, LUTs, text frames) live. */
  jobDir: string;
  textAssets?: Record<string, TextAsset>;
  duckGainAt?: (t: number) => number;
  mediaPath?: (m: MediaItem) => string;
  signal?: AbortSignal;
  onProgress?: (p: JobProgress) => void;
  /** Keep temp files (debugging). */
  keepTemp?: boolean;
}

export function encoderArgs(job: ExportJob): string[] {
  const pr = job.preset;
  const a: string[] = [];
  if (job.kind === 'video') {
    if (pr.codec === 'h265') {
      a.push('-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-preset', pr.speed);
    } else {
      a.push('-c:v', 'libx264', '-preset', pr.speed, '-profile:v', 'high');
    }
    if (pr.bitrateMbps > 0) {
      a.push('-b:v', `${pr.bitrateMbps}M`, '-maxrate', `${Math.round(pr.bitrateMbps * 1.5)}M`, '-bufsize', `${pr.bitrateMbps * 2}M`);
    } else {
      a.push('-crf', String(pr.crf));
    }
    a.push(
      '-pix_fmt', 'yuv420p',
      '-r', String(pr.fps),
      '-g', String(Math.max(1, Math.round(pr.fps / 2))),
      '-bf', '2',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-c:a', 'aac', '-b:a', `${pr.audioBitrateKbps}k`, '-ar', '48000',
      '-movflags', '+faststart',
      '-f', 'mp4',
    );
  } else if (job.kind === 'audio-mp3') {
    a.push('-c:a', 'libmp3lame', '-b:a', `${Math.max(128, pr.audioBitrateKbps)}k`, '-ar', '48000', '-f', 'mp3');
  } else if (job.kind === 'audio-wav') {
    a.push('-c:a', 'pcm_s24le', '-ar', '48000', '-f', 'wav');
  } else if (job.kind === 'frame-png') {
    a.push('-frames:v', '1', '-update', '1', '-f', 'image2', '-c:v', 'png');
  }
  return a;
}

function loadUserLuts(project: Project): Record<string, CubeLut> {
  const out: Record<string, CubeLut> = {};
  for (const c of Object.values(project.clips)) {
    const p = c.color?.lutPath;
    if (!p || out[p]) continue;
    try {
      out[p] = parseCube(fs.readFileSync(p, 'utf8'));
    } catch {
      /* reported as a warning by the graph builder */
    }
  }
  return out;
}

function parseLoudnorm(stderr: string): LoudnormMeasure | null {
  const i = stderr.lastIndexOf('{');
  const j = stderr.lastIndexOf('}');
  if (i < 0 || j < i) return null;
  try {
    const o = JSON.parse(stderr.slice(i, j + 1));
    if (!o.input_i || o.input_i === '-inf') return null;
    return o as LoudnormMeasure;
  } catch {
    return null;
  }
}

/** Longest command line we hand to FFmpeg (Windows CreateProcess allows 32767 characters). */
function cmdLimit(): number {
  const env = Number(process.env.UTS_CMD_LIMIT);
  if (env > 0) return env;
  return process.platform === 'win32' ? 30000 : 200000;
}

function cmdLength(args: string[]): number {
  return args.reduce((a, x) => a + x.length + 3, 0) + 600; // + ffmpeg path and quoting
}

export async function runExport(project: Project, job: ExportJob, ctx: ExportContext): Promise<string> {
  fs.mkdirSync(ctx.jobDir, { recursive: true });
  try {
    return await runExportInner(project, job, ctx);
  } finally {
    // always remove the job's temp files, also when measuring/building fails
    if (!ctx.keepTemp) {
      try {
        fs.rmSync(ctx.jobDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

async function runExportInner(project: Project, job: ExportJob, ctx: ExportContext): Promise<string> {
  const report = (status: JobProgress['status'], progress: number, message?: string, extra: Partial<JobProgress> = {}) =>
    ctx.onProgress?.({ jobId: job.id, status, progress, message, ...extra });
  const userLuts = loadUserLuts(project);
  const wantVideo = job.kind === 'video' || job.kind === 'frame-png';
  const wantAudio = job.kind !== 'frame-png';
  const fps = job.preset.fps;
  const base = {
    project,
    rangeStart: job.rangeStart,
    rangeEnd: job.kind === 'frame-png' ? job.rangeStart + 1 / fps : job.rangeEnd,
    outWidth: job.preset.width,
    outHeight: job.preset.height,
    fps,
    onlyClipIds: job.onlyClipIds,
    mediaPath: ctx.mediaPath ?? ((m: MediaItem) => m.path),
    textAssets: ctx.textAssets,
    userLuts,
    duckGainAt: ctx.duckGainAt,
    pixelFormat: job.kind === 'frame-png' ? ('rgb24' as const) : ('yuv420p' as const),
  };

  // Missing media check
  const missing = Object.values(project.media).filter(
    (m) => !fs.existsSync(m.path) && Object.values(project.clips).some((c) => c.mediaId === m.id),
  );
  if (missing.length) throw new Error(`Missing media: ${missing.map((m) => m.name).join(', ')}. Relink them before exporting.`);

  // Very large timelines can exceed the OS command-line limit (one input per clip): render in
  // time chunks to intermediate files, then join them.
  if (job.kind !== 'frame-png') {
    const g0 = buildGraph({ ...base, video: wantVideo, audio: wantAudio });
    if (cmdLength(g0.args) > cmdLimit()) return renderChunked(job, ctx, base, wantVideo, wantAudio, report);
  }

  let measured: LoudnormMeasure | null = null;
  const normalize = wantAudio && job.normalizeLoudness;
  const encodeShare = normalize ? 0.85 : 1;
  if (normalize) {
    report('running', 0, 'Measuring loudness…');
    const g1 = buildGraph({ ...base, video: false, audio: true, loudnorm: { mode: 'measure', target: job.targetLufs } });
    for (const [name, content] of Object.entries(g1.files)) fs.writeFileSync(path.join(ctx.jobDir, name), content);
    fs.writeFileSync(path.join(ctx.jobDir, 'graph_measure.txt'), g1.filterScript);
    const r1 = await runFfmpeg(
      ['-y', ...g1.args, '-filter_complex_script', 'graph_measure.txt', '-map', `[${g1.audioLabel}]`, '-f', 'null', '-'],
      {
        cwd: ctx.jobDir,
        signal: ctx.signal,
        onProgress: (t) => report('running', Math.min(1, t / g1.duration) * (1 - encodeShare), 'Measuring loudness…'),
      },
    );
    if (r1.code !== 0) throw new Error(ffmpegError(r1.stderr));
    measured = parseLoudnorm(r1.stderr);
  }

  const g = buildGraph({
    ...base,
    video: wantVideo,
    audio: wantAudio,
    loudnorm: normalize && measured ? { mode: 'apply', target: job.targetLufs, measured } : undefined,
  });
  for (const [name, content] of Object.entries(g.files)) fs.writeFileSync(path.join(ctx.jobDir, name), content);
  fs.writeFileSync(path.join(ctx.jobDir, 'graph.txt'), g.filterScript);

  const out = job.outputPath;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const part = out + '.part';
  const maps: string[] = [];
  if (job.kind === 'video') maps.push('-map', `[${g.videoLabel}]`, '-map', `[${g.audioLabel}]`);
  else if (job.kind === 'frame-png') maps.push('-map', `[${g.videoLabel}]`);
  else maps.push('-map', `[${g.audioLabel}]`);
  const args = ['-y', ...g.args, '-filter_complex_script', 'graph.txt', ...maps, '-t', g.duration.toFixed(6), ...encoderArgs(job), part];
  fs.writeFileSync(path.join(ctx.jobDir, 'command.txt'), JSON.stringify(args, null, 1));
  const started = Date.now();
  report('running', 1 - encodeShare, job.kind === 'frame-png' ? 'Rendering frame…' : 'Rendering…');
  try {
    const r = await runFfmpeg(args, {
      cwd: ctx.jobDir,
      signal: ctx.signal,
      onProgress: (t, _speed, encFps) => {
        const k = Math.min(1, t / g.duration);
        const elapsed = (Date.now() - started) / 1000;
        const eta = k > 0.02 ? (elapsed / k) * (1 - k) : undefined;
        report('running', 1 - encodeShare + k * encodeShare, 'Rendering…', { fps: encFps, etaSec: eta });
      },
    });
    if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
    if (!fs.existsSync(part) || fs.statSync(part).size === 0) throw new Error('FFmpeg produced no output');
    try {
      fs.rmSync(out, { force: true });
    } catch {
      /* ignore */
    }
    fs.renameSync(part, out);
  } catch (e) {
    try {
      fs.rmSync(part, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
  report('done', 1, g.warnings.length ? g.warnings.join('\n') : 'Done', { outputPath: out });
  return out;
}

export { CancelledError };

type BuildBase = Omit<Parameters<typeof buildGraph>[0], 'video' | 'audio' | 'loudnorm'>;
type Reporter = (status: JobProgress['status'], progress: number, message?: string, extra?: Partial<JobProgress>) => void;

/** Render the range in pieces that each fit on the command line, then concatenate and encode once. */
async function renderChunked(job: ExportJob, ctx: ExportContext, base: BuildBase, wantVideo: boolean, wantAudio: boolean, report: Reporter): Promise<string> {
  const fps = base.fps;
  const R0 = base.rangeStart;
  const F = Math.max(1, Math.round((base.rangeEnd - R0) * fps));
  const at = (f: number) => R0 + f / fps;
  // remap text assets: chunks run in sub-folders of the job dir
  const textAssets = base.textAssets
    ? Object.fromEntries(Object.entries(base.textAssets).map(([k, v]) => [k, { ...v, pattern: `../${v.pattern}` }]))
    : undefined;
  const sub = { ...base, textAssets };
  const fits = (f0: number, f1: number) => {
    const r = { ...sub, rangeStart: at(f0), rangeEnd: at(f1) };
    const v = wantVideo ? cmdLength(buildGraph({ ...r, video: true, audio: false }).args) : 0;
    const a = wantAudio ? cmdLength(buildGraph({ ...r, video: false, audio: true }).args) : 0;
    return Math.max(v, a) <= cmdLimit();
  };
  const chunks: [number, number][] = [];
  const split = (f0: number, f1: number) => {
    if (f1 - f0 <= 1 || fits(f0, f1)) chunks.push([f0, f1]);
    else {
      const mid = Math.floor((f0 + f1) / 2);
      split(f0, mid);
      split(mid, f1);
    }
  };
  split(0, F);
  const vList: string[] = [];
  const aList: string[] = [];
  const warnings = new Set<string>();
  const renderShare = 0.75;
  for (let i = 0; i < chunks.length; i++) {
    const [f0, f1] = chunks[i];
    const dir = path.join(ctx.jobDir, `chunk_${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const r = { ...sub, rangeStart: at(f0), rangeEnd: at(f1) };
    const dur = ((f1 - f0) / fps).toFixed(6);
    const msg = `Rendering part ${i + 1} of ${chunks.length}…`;
    report('running', (i / chunks.length) * renderShare, msg);
    const run = async (g: ReturnType<typeof buildGraph>, label: string, out: string[], script: string) => {
      for (const [name, content] of Object.entries(g.files)) fs.writeFileSync(path.join(dir, name), content);
      fs.writeFileSync(path.join(dir, script), g.filterScript);
      for (const w of g.warnings) warnings.add(w);
      const res = await runFfmpeg(['-y', ...g.args, '-filter_complex_script', script, '-map', `[${label}]`, '-t', dur, ...out], {
        cwd: dir,
        signal: ctx.signal,
        onProgress: (t) => report('running', ((i + Math.min(1, t / Number(dur))) / chunks.length) * renderShare, msg),
      });
      if (res.code !== 0) throw new Error(ffmpegError(res.stderr));
    };
    if (wantVideo) {
      const g = buildGraph({ ...r, video: true, audio: false });
      await run(g, g.videoLabel!, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(fps), 'v.mkv'], 'graph_v.txt');
      vList.push(`file '${path.join(dir, 'v.mkv').replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    }
    if (wantAudio) {
      const g = buildGraph({ ...r, video: false, audio: true });
      await run(g, g.audioLabel!, ['-c:a', 'pcm_f32le', '-ar', '48000', 'a.wav'], 'graph_a.txt');
      aList.push(`file '${path.join(dir, 'a.wav').replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    }
  }
  const inputs: string[] = [];
  if (wantVideo) {
    fs.writeFileSync(path.join(ctx.jobDir, 'v_list.txt'), vList.join('\n') + '\n');
    inputs.push('-f', 'concat', '-safe', '0', '-i', 'v_list.txt');
  }
  if (wantAudio) {
    fs.writeFileSync(path.join(ctx.jobDir, 'a_list.txt'), aList.join('\n') + '\n');
    inputs.push('-f', 'concat', '-safe', '0', '-i', 'a_list.txt');
  }
  const aIdx = wantVideo ? 1 : 0;
  const total = F / fps;
  let af = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  if (wantAudio && job.normalizeLoudness) {
    report('running', renderShare, 'Measuring loudness…');
    const m = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'a_list.txt', '-af', `loudnorm=I=${job.targetLufs}:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'], {
      cwd: ctx.jobDir,
      signal: ctx.signal,
    });
    if (m.code !== 0) throw new Error(ffmpegError(m.stderr));
    const mm = parseLoudnorm(m.stderr);
    if (mm)
      af = `loudnorm=I=${job.targetLufs}:TP=-1:LRA=11:measured_I=${mm.input_i}:measured_TP=${mm.input_tp}:measured_LRA=${mm.input_lra}:measured_thresh=${mm.input_thresh}:offset=${mm.target_offset}:linear=true,aresample=48000,${af}`;
  }
  const out = job.outputPath;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const part = out + '.part';
  const maps: string[] = [];
  if (wantVideo) maps.push('-map', '0:v');
  if (wantAudio) maps.push('-map', `${aIdx}:a`, '-af', af);
  const args = ['-y', ...inputs, ...maps, '-t', total.toFixed(6), ...encoderArgs(job), part];
  report('running', renderShare + 0.05, 'Encoding…');
  try {
    const r = await runFfmpeg(args, {
      cwd: ctx.jobDir,
      signal: ctx.signal,
      onProgress: (t) => report('running', renderShare + 0.05 + Math.min(1, t / total) * (0.95 - renderShare), 'Encoding…'),
    });
    if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
    if (!fs.existsSync(part) || fs.statSync(part).size === 0) throw new Error('FFmpeg produced no output');
    fs.rmSync(out, { force: true });
    fs.renameSync(part, out);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  report('done', 1, warnings.size ? [...warnings].join('\n') : `Done (rendered in ${chunks.length} parts)`, { outputPath: out });
  return out;
}
