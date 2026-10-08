// Exports timelines that use every transition, speed ramps, keyframed transforms, shake,
// color looks, letterbox and ducking, and checks the output frames/audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject, clipFromMedia, BUILTIN_PRESETS, defaultAdjust, makeClip } from '../shared/defaults';
import { placeClip, tracksOfKind } from '../shared/timelineOps';
import type { ExportJob, Project, TransitionType } from '../shared/types';
import { runExport } from '../electron/export/exporter';
import { ensureTestMedia, addMedia, probeJson, pixelAt, tmpOut, near, volumeAt } from './helpers';
import { uid } from '../shared/time';
import { duckGainAt, computeDuckIntervals } from '../shared/ducking';
import { TRANSITIONS } from '../shared/transitions';

const media = ensureTestMedia();
const jobDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uts-job-'));

function job(out: string, start: number, end: number, w = 640, h = 360, fps = 30): ExportJob {
  const preset = { ...BUILTIN_PRESETS.find((p) => p.id === 'draft')!, width: w, height: h, fps };
  return { id: uid('job_'), kind: 'video', outputPath: out, preset, rangeStart: start, rangeEnd: end, normalizeLoudness: false, targetLufs: -14, label: 't' };
}

async function twoClips(t: TransitionType | null): Promise<Project> {
  const p = createProject('t', '16:9', 30);
  const v1 = tracksOfKind(p, 'video').find((x) => x.name === 'V1')!;
  const G = await addMedia(p, media.green);
  const B = await addMedia(p, media.clipB);
  const a = clipFromMedia(G, v1.id, 0, 30);
  a.duration = 3;
  placeClip(p, a);
  const b = clipFromMedia(B, v1.id, 3, 30);
  b.in = 1;
  b.duration = 3;
  if (t) b.transitionIn = { type: t, duration: 1 };
  placeClip(p, b);
  return p;
}

for (const t of TRANSITIONS.map((x) => x.id) as TransitionType[]) {
  test(`transition ${t} renders`, async () => {
    const p = await twoClips(t);
    const out = tmpOut(`tr_${t}.mp4`);
    await runExport(p, job(out, 1.5, 5), { jobDir: jobDir() });
    const info = probeJson(out);
    assert.ok(Math.abs(info.duration - 3.5) < 0.1, `duration ${info.duration}`);
    // before the transition window: green; after: blue
    assert.ok(near(pixelAt(out, 0.3, 320, 180), [0, 255, 0], 30), 'green before');
    assert.ok(near(pixelAt(out, 3.2, 600, 330), [0x20, 0x60, 0xff], 30), 'blue after');
    const mid = pixelAt(out, 1.5, 320, 180); // exactly at the cut (t=3)
    if (t === 'dipBlack') assert.ok(mid.every((v) => v < 40), `dip black mid ${mid}`);
    if (t === 'dipWhite') assert.ok(mid.every((v) => v > 215), `dip white mid ${mid}`);
    if (t === 'crossfade') assert.ok(!near(mid, [0, 255, 0], 30) && !near(mid, [0x20, 0x60, 0xff], 30), `crossfade mid ${mid}`);
    const BLUE: [number, number, number] = [0x20, 0x60, 0xff];
    const GREEN: [number, number, number] = [0, 255, 0];
    if (t === 'wipeRight') {
      assert.ok(near(pixelAt(out, 1.5, 40, 300), BLUE, 40), `wipe left side ${pixelAt(out, 1.5, 40, 300)}`);
      assert.ok(near(pixelAt(out, 1.5, 600, 300), GREEN, 40), `wipe right side ${pixelAt(out, 1.5, 600, 300)}`);
    }
    if (t === 'iris') {
      assert.ok(near(pixelAt(out, 1.5, 330, 200), BLUE, 40), `iris centre ${pixelAt(out, 1.5, 330, 200)}`);
      assert.ok(near(pixelAt(out, 1.5, 8, 8), GREEN, 40), `iris corner ${pixelAt(out, 1.5, 8, 8)}`);
    }
    if (t === 'pushLeft') {
      // half way: A pushed half out to the left, B covering the right half
      assert.ok(near(pixelAt(out, 1.5, 100, 300), GREEN, 40), `push left half ${pixelAt(out, 1.5, 100, 300)}`);
      assert.ok(near(pixelAt(out, 1.5, 560, 300), BLUE, 40), `push right half ${pixelAt(out, 1.5, 560, 300)}`);
    }
  });
}

test('picture fade in/out to black and to transparent', async () => {
  const p = await twoClips(null);
  const [a, b] = Object.values(p.clips).sort((x, y) => x.start - y.start);
  a.videoFadeIn = 1;
  b.videoFadeOut = 1;
  b.fadeColor = 'white';
  const out = tmpOut('fades.mp4');
  await runExport(p, job(out, 0, 6), { jobDir: jobDir() });
  assert.ok(pixelAt(out, 0.02, 320, 180).every((v) => v < 30), `starts black ${pixelAt(out, 0.02, 320, 180)}`);
  const half = pixelAt(out, 0.5, 320, 180);
  assert.ok(half[1] > 60 && half[1] < 220, `half faded ${half}`);
  assert.ok(near(pixelAt(out, 2, 320, 180), [0, 255, 0], 30), 'full green');
  assert.ok(pixelAt(out, 5.95, 600, 330).every((v) => v > 215), `ends white ${pixelAt(out, 5.95, 600, 330)}`);
});

test('speed ramp + constant speed + reverse-free timing', async () => {
  const p = createProject('t', '16:9', 30);
  const v1 = tracksOfKind(p, 'video').find((x) => x.name === 'V1')!;
  const A = await addMedia(p, media.clipA);
  const c = clipFromMedia(A, v1.id, 0, 30);
  c.duration = 4;
  c.speedKeys = [
    { t: 0, v: 0.5, ease: 'easeInOut' },
    { t: 2, v: 0.5, ease: 'easeInOut' },
    { t: 3, v: 1.5, ease: 'linear' },
    { t: 4, v: 1.5, ease: 'linear' },
  ];
  placeClip(p, c);
  const c2 = clipFromMedia(A, v1.id, 4, 30);
  c2.speed = 2;
  c2.duration = 2;
  placeClip(p, c2);
  const out = tmpOut('ramp.mp4');
  await runExport(p, job(out, 0, 6), { jobDir: jobDir() });
  const info = probeJson(out);
  assert.ok(Math.abs(info.duration - 6) < 0.1);
  assert.equal(Number(info.streams.find((s) => s.codec_type === 'video')!.nb_frames), 180);
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.ok(a, 'audio present (atempo segments)');
});

test('keyframed transform, rotation, opacity, shake, color look, vignette, letterbox', async () => {
  const p = createProject('t', '16:9', 30);
  const [v1, v2, v3] = ['V1', 'V2', 'V3'].map((n) => tracksOfKind(p, 'video').find((x) => x.name === n)!);
  const A = await addMedia(p, media.clipA);
  const L = await addMedia(p, media.logo);
  const c = clipFromMedia(A, v1.id, 0, 30);
  c.duration = 4;
  c.transform.scale = { value: 1, keys: [{ t: 0, v: 1, ease: 'easeInOut' }, { t: 2, v: 1.4, ease: 'linear' }] };
  c.shakes = [{ at: 1, duration: 0.8, intensity: 0.8, frequency: 9 }];
  c.color = { ...c.color, look: 'horror', vignette: 0.6, saturation: -0.2 };
  placeClip(p, c);
  const l = clipFromMedia(L, v2.id, 0.5, 30);
  l.duration = 3;
  l.fit = 'fit';
  l.transform.scale = { value: 0.3 };
  l.transform.rotation = { value: 0, keys: [{ t: 0, v: 0, ease: 'linear' }, { t: 3, v: 90, ease: 'linear' }] };
  l.transform.opacity = { value: 1, keys: [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 1, ease: 'linear' }] };
  l.transform.x = { value: 0, keys: [{ t: 0, v: -500, ease: 'easeOut' }, { t: 2, v: 500, ease: 'linear' }] };
  placeClip(p, l);
  const lb = makeClip('adjust', v3.id, 0, 4, { adjust: defaultAdjust() });
  placeClip(p, lb);
  const out = tmpOut('fx.mp4');
  await runExport(p, job(out, 0, 4), { jobDir: jobDir() });
  assert.ok(Math.abs(probeJson(out).duration - 4) < 0.1);
  // letterbox: top rows black
  const top = pixelAt(out, 2, 320, 10);
  assert.ok(top.every((v) => v < 20), `letterbox top ${top}`);
});

test('auto-ducking lowers the music while SFX plays', async () => {
  const p = createProject('t', '16:9', 30);
  const music = tracksOfKind(p, 'audio').find((t) => t.role === 'music')!;
  const sfx = tracksOfKind(p, 'audio').find((t) => t.role === 'sfx')!;
  const M = await addMedia(p, media.music, 'music');
  const S = await addMedia(p, media.clipB); // 880Hz tone as "sfx"
  const cm = clipFromMedia(M, music.id, 0, 30);
  cm.duration = 8;
  placeClip(p, cm);
  const cs = makeClip('audio', sfx.id, 3, 2, { mediaId: S.id });
  placeClip(p, cs);
  p.settings.duckingEnabled = true;
  p.settings.duckAmountDb = 18;
  const iv = computeDuckIntervals(p, {});
  assert.equal(iv.length, 1);
  assert.ok(duckGainAt(p, iv, 4) < 0.2);
  assert.equal(duckGainAt(p, iv, 1), 1);
  // export only the music clip to measure the ducked level
  const out = tmpOut('duck.wav');
  const j: ExportJob = { ...job(out, 0, 8), kind: 'audio-wav', onlyClipIds: [cm.id] };
  await runExport(p, j, { jobDir: jobDir(), duckGainAt: (t) => duckGainAt(p, iv, t) });
  const before = volumeAt(out, 1, 1);
  const during = volumeAt(out, 3.6, 1);
  assert.ok(before - during > 12, `ducking ${before} -> ${during}`);
});

test('constant clip blur renders softly (end-screen background)', async () => {
  const p = await twoClips(null);
  const b = Object.values(p.clips).sort((x, y) => x.start - y.start)[1];
  b.blur = 20;
  const out = tmpOut('blur.mp4');
  await runExport(p, job(out, 3, 4), { jobDir: jobDir() });
  // the sharp yellow box edge (x=100..300 at 1920 → 33..100 at 640) becomes a soft gradient
  const inside = pixelAt(out, 0.5, 66, 50);
  const edge = pixelAt(out, 0.5, 100, 50);
  assert.ok(inside[0] > 150, `inside ${inside}`);
  assert.ok(edge[0] > 60 && edge[0] < 200, `edge is soft ${edge}`);
});

test('effects apply on the very first frame (single-frame PNG export at a fade)', async () => {
  const p = await twoClips(null);
  const [a] = Object.values(p.clips).sort((x, y) => x.start - y.start);
  a.videoFadeIn = 2;
  a.blur = 12;
  const out = tmpOut('first.png');
  const preset = { ...BUILTIN_PRESETS.find((x) => x.id === 'draft')!, width: 640, height: 360, fps: 30 };
  await runExport(p, { id: uid('j'), kind: 'frame-png', outputPath: out, preset, rangeStart: 1, rangeEnd: 1, normalizeLoudness: false, targetLufs: -14, label: 't' }, { jobDir: jobDir() });
  const px = pixelAt(out, 0, 320, 180);
  // half-way through a 2 s fade from black: clearly darker than full green
  assert.ok(px[1] > 40 && px[1] < 200, `first frame faded ${px}`);
});

test('crossfade into a clip with no handle (in = 0): blends from the start and stays in sync', async () => {
  const p = createProject('t', '16:9', 30);
  const v1 = tracksOfKind(p, 'video').find((x) => x.name === 'V1')!;
  const G = await addMedia(p, media.green);
  const A = await addMedia(p, media.clipA); // testsrc2: has a running clock, so timing is visible
  const a = clipFromMedia(G, v1.id, 0, 30);
  a.duration = 3;
  placeClip(p, a);
  const b = clipFromMedia(A, v1.id, 3, 30);
  b.in = 0;
  b.duration = 3;
  b.transitionIn = { type: 'crossfade', duration: 1 };
  placeClip(p, b);
  const out = tmpOut('xf_in0.mp4');
  await runExport(p, job(out, 2, 6), { jobDir: jobDir() });
  // 0.3 s before the cut B is already fading in (not pure green)
  const pre = pixelAt(out, 0.7, 320, 180);
  assert.ok(!near(pre, [0, 255, 0], 12), `B visible before the cut ${pre}`);
  // B's picture at timeline 4.5 s must equal the source at 1.5 s (no delay)
  const exported = pixelAt(out, 2.5, 120, 40);
  const src = pixelAt(media.clipA, 1.5, 240, 80); // source is 1280x720, export 640x360
  assert.ok(near(exported, src, 40), `in sync: ${exported} vs ${src}`);
});
