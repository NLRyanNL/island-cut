import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProject, clipFromMedia, BUILTIN_PRESETS } from '../shared/defaults';
import { placeClip, tracksOfKind } from '../shared/timelineOps';
import type { ExportJob, Project } from '../shared/types';
import { runExport } from '../electron/export/exporter';
import { ensureTestMedia, addMedia, probeJson, pixelAt, tmpOut, near, volumeAt } from './helpers';
import { uid } from '../shared/time';

const media = ensureTestMedia();

function job(kind: ExportJob['kind'], out: string, start: number, end: number, extra: Partial<ExportJob> = {}): ExportJob {
  const preset = { ...BUILTIN_PRESETS.find((p) => p.id === 'draft')!, width: 640, height: 360, fps: 30 };
  return { id: uid('job_'), kind, outputPath: out, preset, rangeStart: start, rangeEnd: end, normalizeLoudness: false, targetLufs: -14, label: 't', ...extra };
}

async function basicProject(): Promise<Project> {
  const p = createProject('t', '16:9', 30);
  const v1 = tracksOfKind(p, 'video').find((t) => t.name === 'V1')!;
  const v2 = tracksOfKind(p, 'video').find((t) => t.name === 'V2')!;
  const a2 = tracksOfKind(p, 'audio').find((t) => t.role === 'music')!;
  const A = await addMedia(p, media.clipA);
  const B = await addMedia(p, media.clipB);
  const L = await addMedia(p, media.logo);
  const M = await addMedia(p, media.music, 'music');
  const ca = clipFromMedia(A, v1.id, 0, 30);
  ca.in = 1;
  ca.duration = 3;
  placeClip(p, ca);
  const cb = clipFromMedia(B, v1.id, 3, 30);
  cb.duration = 3;
  placeClip(p, cb);
  const cl = clipFromMedia(L, v2.id, 1, 30);
  cl.duration = 1;
  cl.fit = 'fit';
  cl.transform.scale = { value: 0.25 };
  cl.transform.x = { value: -600 };
  placeClip(p, cl);
  const cm = clipFromMedia(M, a2.id, 0, 30);
  cm.duration = 6;
  cm.volume = 0.5;
  placeClip(p, cm);
  return p;
}

test('exports a basic multi-track timeline to MP4', async () => {
  const p = await basicProject();
  const out = tmpOut('basic.mp4');
  await runExport(p, job('video', out, 0, 6), { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-job-')) });
  const info = probeJson(out);
  assert.ok(Math.abs(info.duration - 6) < 0.1, `duration ${info.duration}`);
  const v = info.streams.find((s) => s.codec_type === 'video')!;
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(Number(v.nb_frames), 180);
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  // second clip (blue background) visible after 3s
  const px = pixelAt(out, 4.5, 600, 300);
  assert.ok(near(px, [0x20, 0x60, 0xff], 20), `blue expected, got ${px}`);
  // logo (red) visible at 1.5s on the left side, not at 2.5s
  const lx = Math.round(320 - (600 * 640) / 1920);
  const red = pixelAt(out, 1.5, lx, 180);
  assert.ok(near(red, [255, 0, 0], 40), `red logo expected, got ${red}`);
  const notRed = pixelAt(out, 2.5, lx, 180);
  assert.ok(!near(notRed, [255, 0, 0], 40), `logo should be gone, got ${notRed}`);
});

test('crossfade transition blends both clips', async () => {
  const p = await basicProject();
  const cb = Object.values(p.clips).find((c) => c.name === 'clipB.mkv')!;
  cb.transitionIn = { type: 'crossfade', duration: 1 };
  const out = tmpOut('xfade.mp4');
  await runExport(p, job('video', out, 2, 4.5), { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-job-')) });
  const info = probeJson(out);
  assert.ok(Math.abs(info.duration - 2.5) < 0.1);
  // at the cut (t=3 => 1.0s into the render) blue should be ~50% mixed
  const mid = pixelAt(out, 1.0, 600, 330);
  const after = pixelAt(out, 2.0, 600, 330);
  assert.ok(near(after, [0x20, 0x60, 0xff], 20), `after ${after}`);
  assert.ok(!near(mid, [0x20, 0x60, 0xff], 20), `mid should be mixed ${mid}`);
});

test('exports audio only (wav + mp3) and a PNG frame', async () => {
  const p = await basicProject();
  const wav = tmpOut('mix.wav');
  await runExport(p, job('audio-wav', wav, 0, 6), { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-job-')) });
  assert.ok(Math.abs(probeJson(wav).duration - 6) < 0.05);
  const mp3 = tmpOut('mix.mp3');
  await runExport(p, job('audio-mp3', mp3, 0, 6, { normalizeLoudness: true }), { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-job-')) });
  assert.ok(Math.abs(probeJson(mp3).duration - 6) < 0.1);
  const v = volumeAt(mp3, 0.5, 4);
  assert.ok(v > -30 && v < -8, `normalized volume ${v}`);
  const png = tmpOut('frame.png');
  await runExport(p, job('frame-png', png, 4, 4), { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-job-')) });
  assert.ok(near(pixelAt(png, 0, 600, 300), [0x20, 0x60, 0xff], 20));
});

test('cancel stops the export and removes partial output', async () => {
  const p = await basicProject();
  const out = tmpOut('cancel.mp4');
  fs.rmSync(out, { force: true });
  const ac = new AbortController();
  const j = job('video', out, 0, 6);
  j.preset = { ...j.preset, width: 1920, height: 1080, fps: 60, speed: 'slow', crf: 10 };
  setTimeout(() => ac.abort(), 600);
  await assert.rejects(runExport(p, j, { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-job-')), signal: ac.signal }), /Cancelled/);
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.existsSync(out + '.part'));
});
