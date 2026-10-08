// Built-in self test (launch with UTS_SELFTEST=1). Drives the real UI code on this machine:
// generates test media with the bundled FFmpeg, imports it, edits, plays, exports, saves and reloads,
// then writes a JSON report and quits. Used to verify a fresh install on Windows.
import { getState, setUI } from './store/store';
import * as actions from './store/actions';
import { enqueue } from './export/queue';
import { tracksOfKind } from '../shared/timelineOps';
import { buildTemplate } from './presets/templates';
import { buildConcept, buildTrailerProject, parseStyle } from '../shared/autotrailer';
import { ensureFont } from './fonts/bundled';
import { DEFAULT_LOGO, removeBackground, renderTextLogo } from './components/logo/logoRender';

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  info?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
}

export async function runSelfTest(): Promise<void> {
  const results: StepResult[] = [];
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(String(e.error?.stack ?? e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String((e.reason as Error)?.stack ?? e.reason)));
  const step = async (name: string, fn: () => Promise<string | void>) => {
    const t0 = performance.now();
    try {
      const info = await fn();
      results.push({ name, ok: true, ms: Math.round(performance.now() - t0), info: info ?? undefined });
    } catch (e) {
      results.push({ name, ok: false, ms: Math.round(performance.now() - t0), info: String((e as Error)?.stack ?? e) });
    }
  };
  await sleep(1500);
  let media: { dir: string; files: Record<string, string> } = { dir: '', files: {} };
  await step('generate test media (bundled ffmpeg)', async () => {
    media = await window.api.selftestMedia();
    return Object.values(media.files).join(', ');
  });
  await step('import media', async () => {
    const items = await actions.importFiles(Object.values(media.files));
    if (items.length !== 4) throw new Error(`imported ${items.length}`);
  });
  await step('thumbnails + proxies', async () => {
    await waitFor(() => {
      const rt = getState().rt;
      const vids = Object.values(getState().project.media).filter((m) => m.kind === 'video');
      return vids.every((m) => rt.proxies[m.id]?.state === 'ready' || rt.proxies[m.id]?.state === 'error');
    }, 180000, 'proxies');
    const bad = Object.values(getState().rt.proxies).filter((p) => p.state === 'error');
    if (bad.length) throw new Error(bad.map((b) => b.error).join('; '));
    return `${Object.keys(getState().rt.thumbs).length} thumbs`;
  });
  await step('build timeline', async () => {
    const p = getState().project;
    const by = (n: string) => Object.values(p.media).find((m) => m.name.startsWith(n))!;
    actions.addMediaToTimeline(by('clipA').id, null, 0);
    actions.appendToTimeline(by('clipB').id);
    actions.addMediaToTimeline(by('music').id, null, 0);
    const v2 = tracksOfKind(getState().project, 'video').find((t) => t.name === 'V2')!;
    actions.addMediaToTimeline(by('logo').id, v2.id, 1);
    // a wipe-style transition exercises the geq mask path of the bundled FFmpeg
    const vb = Object.values(getState().project.clips).find((c) => c.mediaId === by('clipB').id)!;
    actions.setTransition(vb.id, 'iris', 0.6);
    actions.setPlayhead(1);
    actions.addTextClip();
    actions.zoomToFit(1200);
    return `${Object.keys(getState().project.clips).length} clips`;
  });
  await step('extract audio + split + undo/redo', async () => {
    const v = Object.values(getState().project.clips).find((c) => c.kind === 'video')!;
    actions.extractAudio(v.id);
    actions.setPlayhead(2);
    const n0 = Object.keys(getState().project.clips).length;
    actions.splitAtPlayhead();
    const n1 = Object.keys(getState().project.clips).length;
    actions.undo();
    const n2 = Object.keys(getState().project.clips).length;
    actions.redo();
    if (!(n1 > n0 && n2 === n0)) throw new Error(`${n0} ${n1} ${n2}`);
  });
  await step('beat detection', async () => {
    const m = Object.values(getState().project.clips).find((c) => c.name.startsWith('music'))!;
    await actions.detectBeatsFor(m.id);
    const bpm = getState().project.media[m.mediaId!].bpm;
    if (!bpm || Math.abs(bpm - 120) > 3) throw new Error(`bpm ${bpm}`);
    return `${bpm} BPM`;
  });
  await step('preview playback (2s)', async () => {
    actions.setPlayhead(0);
    await sleep(500);
    setUI({ playing: true, rate: 1 });
    await sleep(2000);
    setUI({ playing: false });
    const t = getState().ui.playhead;
    if (t < 1.4 || t > 2.8) throw new Error(`playhead ${t}`);
    const canvas = document.querySelector('.preview-stage canvas') as HTMLCanvasElement;
    const c2 = document.createElement('canvas');
    c2.width = 64;
    c2.height = 36;
    const ctx = c2.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    if (sum < 1000) throw new Error('preview is black');
    return `playhead ${t.toFixed(2)}s, preview ok`;
  });
  await step('export MP4 (queue, -14 LUFS)', async () => {
    const out = `${media.dir}/selftest-export.mp4`;
    await window.api.allowPaths([out]);
    enqueue({
      id: 'selftest_job',
      kind: 'video',
      outputPath: out,
      preset: { id: 't', name: 't', width: 1280, height: 720, fps: 30, codec: 'h264', bitrateMbps: 0, crf: 26, audioBitrateKbps: 160, speed: 'veryfast' },
      rangeStart: 0,
      rangeEnd: 6,
      normalizeLoudness: true,
      targetLufs: -14,
      label: 'selftest',
    });
    await waitFor(() => {
      const q = getState().rt.queue.find((x) => x.job.id === 'selftest_job');
      return !!q && (q.progress.status === 'done' || q.progress.status === 'error' || q.progress.status === 'cancelled');
    }, 300000, 'export');
    const q = getState().rt.queue.find((x) => x.job.id === 'selftest_job')!;
    if (q.progress.status !== 'done') throw new Error(q.progress.message);
    const pr = (await window.api.probe([out]))[0];
    if (!pr.ok || Math.abs(pr.duration - 6) > 0.2 || pr.width !== 1280) throw new Error(JSON.stringify(pr));
    return `${out} ${pr.duration.toFixed(2)}s ${pr.width}x${pr.height}`;
  });
  await step('export PNG frame + audio WAV', async () => {
    const png = `${media.dir}/selftest-frame.png`;
    const wav = `${media.dir}/selftest-audio.wav`;
    await window.api.allowPaths([png, wav]);
    const base = { preset: { id: 't', name: 't', width: 1920, height: 1080, fps: 30, codec: 'h264' as const, bitrateMbps: 0, crf: 20, audioBitrateKbps: 160, speed: 'veryfast' as const }, normalizeLoudness: false, targetLufs: -14, label: 't' };
    enqueue({ ...base, id: 'st_png', kind: 'frame-png', outputPath: png, rangeStart: 1.5, rangeEnd: 1.5 });
    enqueue({ ...base, id: 'st_wav', kind: 'audio-wav', outputPath: wav, rangeStart: 0, rangeEnd: 4 });
    await waitFor(() => ['st_png', 'st_wav'].every((id) => ['done', 'error'].includes(getState().rt.queue.find((x) => x.job.id === id)?.progress.status ?? '')), 120000, 'png/wav');
    const failed = getState().rt.queue.filter((x) => ['st_png', 'st_wav'].includes(x.job.id) && x.progress.status !== 'done');
    if (failed.length) throw new Error(failed.map((f) => f.progress.message).join('; '));
  });
  await step('save + reload project (relative paths)', async () => {
    const file = `${media.dir}/selftest.uts.json`;
    await window.api.allowPaths([file]);
    await window.api.saveProject(getState().project, file);
    const p = await window.api.loadProject(file);
    if (Object.values(p.media).some((m) => m.missing)) throw new Error('media missing after reload');
    return file;
  });
  await step('templates', async () => {
    for (const id of ['gameplay30', 'cinematic60', 'short15']) {
      const p = buildTemplate(id, 60);
      if (!Object.keys(p.clips).length) throw new Error(id);
    }
  });
  await step('auto trailer (analysis + concept + build)', async () => {
    const p = getState().project;
    const vids = Object.values(p.media).filter((m) => m.kind === 'video');
    const analyses: Record<string, Awaited<ReturnType<typeof window.api.analyzeMedia>>> = {};
    for (const m of vids) analyses[m.id] = await window.api.analyzeMedia(m);
    const style = parseStyle('20s cinematic horror trailer, title "SELF TEST", code 1234-5678-9012', { mode: 'cinematic', duration: 20, aspect: '16:9' });
    const music = Object.values(p.media).find((m) => m.kind === 'audio');
    const c = buildConcept(style, vids.map((m) => ({ media: m, analysis: analyses[m.id] })), music?.id);
    const built = buildTrailerProject(p, c, { fps: 30, beats: music?.beats ?? [], analyses });
    const n = Object.values(built.clips).filter((x) => x.kind === 'video').length;
    if (n < 4) throw new Error(`only ${n} shots`);
    return `${c.sections.length} sections, ${n} shots`;
  });
  await step('bundled fonts', async () => {
    const list = await window.api.bundledFonts();
    if (list.length < 20) throw new Error(`only ${list.length} bundled fonts`);
    await ensureFont('Luckiest Guy');
    if (!document.fonts.check('48px "Luckiest Guy"')) throw new Error('Luckiest Guy not loaded');
    return `${list.length} fonts`;
  });
  await step('logo maker (text logo + background removal)', async () => {
    const cv = renderTextLogo({ ...DEFAULT_LOGO, line1: 'SELF TEST', line2: 'ISLAND' });
    if (cv.width < 200 || cv.height < 80) throw new Error(`logo ${cv.width}x${cv.height}`);
    const img = new ImageData(40, 20);
    for (let i = 0; i < img.data.length; i += 4) img.data.set([255, 255, 255, 255], i);
    for (let y = 5; y < 15; y++) for (let x = 10; x < 30; x++) img.data.set([255, 0, 0, 255], (y * 40 + x) * 4);
    const out = removeBackground(img, { color: null, tolerance: 25, feather: 30, connected: true });
    if (out.data[3] !== 0 || out.data[(10 * 40 + 20) * 4 + 3] !== 255) throw new Error('background removal');
    return `${cv.width}x${cv.height}`;
  });
  await step('built-in sound effects (generated)', async () => {
    const list = await window.api.builtinSfx();
    if (list.length < 10) throw new Error(`only ${list.length} sounds`);
    const pr = await window.api.probe(list.map((x) => x.path));
    const bad = pr.filter((x) => !x.ok || x.duration < 0.2);
    if (bad.length) throw new Error(`${bad.length} broken sounds`);
    return `${list.length} sounds`;
  });
  await step('update check', async () => {
    const u = await window.api.checkForUpdate();
    if (u.status === 'error') throw new Error(u.message);
    return u.status;
  });
  await step('system fonts', async () => {
    const f = await window.api.listFonts();
    if (f.length < 5) throw new Error(`only ${f.length} fonts`);
    return `${f.length} fonts`;
  });
  const ok = results.every((r) => r.ok) && errors.length === 0;
  await window.api.selftestDone({ ok, results, errors, userAgent: navigator.userAgent, gl: !!document.createElement('canvas').getContext('webgl2') });
}
