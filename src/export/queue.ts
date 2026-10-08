import { ensureFont } from '../fonts/bundled';
// Render queue: jobs run one after another in a separate FFmpeg process (main side).
// Text clips are rendered to PNG frames here (same renderer as the preview) before each job starts.
import type { ExportJob, JobProgress, Project } from '../../shared/types';
import type { TextAsset } from '../../shared/render/buildGraph';
import { getState, setRT, toast } from '../store/store';
import { drawText, textIsAnimated } from '../preview/textRender';
import { clipEnd } from '../../shared/timelineOps';
import { visualTracksBottomUp } from '../../shared/evaluate';

interface Pending {
  job: ExportJob;
  project: Project;
}

const pending = new Map<string, Pending>();
let running: string | null = null;
let listening = false;

function update(jobId: string, patch: Partial<JobProgress>): void {
  setRT((rt) => ({
    queue: rt.queue.map((q) => (q.job.id === jobId ? { ...q, progress: { ...q.progress, ...patch } } : q)),
  }));
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.api.onExportProgress((p) => {
    if (p.status === 'done' || p.status === 'error' || p.status === 'cancelled') return; // final state set by runner
    update(p.jobId, p);
  });
}

export function enqueue(job: ExportJob, project?: Project): void {
  listen();
  const snapshot = structuredClone(project ?? getState().project);
  pending.set(job.id, { job, project: snapshot });
  setRT((rt) => ({ queue: [...rt.queue, { job, progress: { jobId: job.id, status: 'queued', progress: 0 } }] }));
  pump();
}

export function cancelJob(jobId: string): void {
  if (running === jobId) {
    window.api.exportCancel(jobId);
    cancelledWhilePreparing.add(jobId);
    return;
  }
  pending.delete(jobId);
  update(jobId, { status: 'cancelled', message: 'Removed from queue' });
}

export function clearFinished(): void {
  setRT((rt) => ({ queue: rt.queue.filter((q) => q.progress.status === 'queued' || q.progress.status === 'running' || q.progress.status === 'preparing') }));
}

const cancelledWhilePreparing = new Set<string>();

async function pump(): Promise<void> {
  if (running) return;
  const next = getState().rt.queue.find((q) => q.progress.status === 'queued' && pending.has(q.job.id));
  if (!next) return;
  const { job, project } = pending.get(next.job.id)!;
  pending.delete(job.id);
  running = job.id;
  try {
    update(job.id, { status: 'preparing', progress: 0, message: 'Preparing titles…' });
    const dir = await window.api.exportPrepare(job.id);
    const assets = await renderTextAssets(project, job, dir, (k) => update(job.id, { progress: k * 0.05 }));
    if (cancelledWhilePreparing.has(job.id)) throw new Error('Cancelled');
    update(job.id, { status: 'running', message: 'Rendering…' });
    const out = await window.api.exportRun(job, project, assets);
    update(job.id, { status: 'done', progress: 1, message: 'Done', outputPath: out });
    toast(`Export finished: ${out.split(/[\\/]/).pop()}`, 'success', 6000);
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    const cancelled = /cancel/i.test(msg);
    update(job.id, { status: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Cancelled' : msg });
    if (!cancelled) toast(`Export failed: ${msg}`, 'error', 10000);
  } finally {
    cancelledWhilePreparing.delete(job.id);
    running = null;
    setTimeout(pump, 50);
  }
}

/** Render every text clip in the job range to PNG(s) at the output resolution. */
export async function renderTextAssets(project: Project, job: ExportJob, dir: string, onProgress?: (k: number) => void): Promise<Record<string, TextAsset>> {
  if (job.kind !== 'video' && job.kind !== 'frame-png') return {};
  const W = project.settings.width;
  const H = project.settings.height;
  const k = Math.min(job.preset.width / W, job.preset.height / H);
  const CW = Math.max(2, Math.round((W * k) / 2) * 2);
  const CH = Math.max(2, Math.round((H * k) / 2) * 2);
  const fps = job.preset.fps;
  const R0 = job.rangeStart;
  const R1 = job.kind === 'frame-png' ? job.rangeStart + 1 / fps : job.rangeEnd;
  const textTracks = new Set(visualTracksBottomUp(project).filter((t) => !t.hidden).map((t) => t.id));
  const clips = Object.values(project.clips).filter((c) => c.kind === 'text' && c.text && textTracks.has(c.trackId) && clipEnd(c) > R0 && c.start < R1);
  const out: Record<string, TextAsset> = {};
  // every font used must be loaded, or the export silently falls back to Arial
  for (const c of clips) await ensureFont(c.text!.fontFamily, c.text!.fontWeight);
  const canvas = new OffscreenCanvas(CW, CH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let totalFrames = 0;
  for (const c of clips) totalFrames += textIsAnimated(c.text!) ? Math.ceil((Math.min(clipEnd(c), R1) - Math.max(c.start, R0)) * fps) + 1 : 1;
  let done = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const t = c.text!;
    const a = Math.max(c.start, R0);
    const b = Math.min(clipEnd(c), R1);
    if (!textIsAnimated(t) || job.kind === 'frame-png') {
      const local = Math.max(0, a - c.start);
      drawText(ctx, CW, CH, t, local, c.duration, fps, H);
      const name = `text_${i}.png`;
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      await window.api.writeJobFile(dir, name, new Uint8Array(await blob.arrayBuffer()));
      out[c.id] = { pattern: name, sequence: false, start: a, duration: b - a, fps };
      done++;
      continue;
    }
    // animated: one PNG per output frame (static middle frames reuse the same bytes)
    const f0 = Math.ceil((a - R0) * fps - 1e-6);
    const f1 = Math.ceil((b - R0) * fps - 1e-6);
    let staticBytes: Uint8Array | null = null;
    for (let f = f0; f < f1 + 1; f++) {
      const local = R0 + f / fps - c.start;
      const isStatic = local >= t.animInDuration + 0.75 && (t.animOut === 'none' || local <= c.duration - t.animOutDuration) && t.animIn !== 'typewriter';
      let bytes: Uint8Array;
      if (isStatic && staticBytes) bytes = staticBytes;
      else {
        drawText(ctx, CW, CH, t, Math.max(0, Math.min(c.duration, local)), c.duration, fps, H);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        bytes = new Uint8Array(await blob.arrayBuffer());
        if (isStatic) staticBytes = bytes;
      }
      await window.api.writeJobFile(dir, `text_${i}_${String(f - f0).padStart(5, '0')}.png`, bytes);
      done++;
      if (done % 10 === 0) onProgress?.(done / Math.max(1, totalFrames));
    }
    out[c.id] = { pattern: `text_${i}_%05d.png`, sequence: true, start: R0 + f0 / fps, duration: b - a, fps };
  }
  return out;
}
