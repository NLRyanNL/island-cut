import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseStyle, hudReframe, buildConcept, buildTrailerProject, applyAiConcept, applyAiFrameReview } from '../shared/autotrailer';
import { analyzeFootage } from '../shared/analysis';
import { createProject, BUILTIN_PRESETS } from '../shared/defaults';
import { ffmpegPath } from '../electron/ffmpeg/binaries';
import { runExport } from '../electron/export/exporter';
import { addMedia, ensureTestMedia, probeJson, tmpOut, MEDIA_DIR, pixelAt } from './helpers';
import { projectDuration } from '../shared/timelineOps';

const media = ensureTestMedia();

/** Synthetic gameplay: moving fractal + static HUD (first 6 s) + automatic gunfire at 1-4 s. */
function hudClip(): string {
  const out = path.join(MEDIA_DIR, 'hudtest.mp4');
  if (fs.existsSync(out)) return out;
  execFileSync(ffmpegPath(), [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'mandelbrot=s=1280x720:r=30,trim=duration=12,setpts=PTS-STARTPTS',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,4),0.9*exp(-120*mod(t,0.1))*(random(0)*2-1),0)+0.06*sin(2*PI*220*t)':s=44100:d=12",
    '-filter_complex',
    "[0:v]drawbox=x=1080:y=20:w=170:h=170:color=white:t=6:enable='lt(t,6)',drawbox=x=1100:y=40:w=40:h=40:color=yellow:t=fill:enable='lt(t,6)',drawbox=x=30:y=650:w=300:h=30:color=white:t=4:enable='lt(t,6)',drawbox=x=36:y=656:w=200:h=18:color=green:t=fill:enable='lt(t,6)'[v]",
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', out,
  ]);
  return out;
}

function analyze(file: string, duration: number) {
  const w = 160, h = 90, fps = 4;
  const frames = execFileSync(ffmpegPath(), ['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const a = execFileSync(ffmpegPath(), ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return analyzeFootage({ frames: new Uint8Array(frames), w, h, fps }, new Float32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)), 8000, duration);
}

test('style parsing understands a creator prompt', () => {
  const s = parseStyle('60s horror trailer, slow creepy build then fast cuts on the beat, title "KILLER CLOWN", code 1234-5678-9012, coming soon', { mode: 'cinematic', duration: 30, aspect: '16:9' });
  assert.equal(s.duration, 60);
  assert.equal(s.mood, 'horror');
  assert.equal(s.look, 'horror');
  assert.equal(s.title, 'KILLER CLOWN');
  assert.equal(s.islandCode, '1234-5678-9012');
  assert.equal(s.endCard, 'both');
  const v = parseStyle('hype tiktok for my parkour map', { mode: 'gameplay', duration: 30, aspect: '16:9' });
  assert.equal(v.aspect, '9:16');
  assert.equal(v.duration, 15);
  assert.equal(v.pacing, 'fast');
});

test('HUD is detected and cropped away; gunfire is flagged', () => {
  const a = analyze(hudClip(), 12);
  assert.ok(a.hudBoxes.some((b) => b.x > 0.75 && b.y < 0.2), 'minimap box');
  assert.ok(a.hudBoxes.some((b) => b.x < 0.1 && b.y > 0.8), 'health bar box');
  assert.ok(a.hud[2] > 0.6 && a.hud[9] < 0.5, `hud presence ${a.hud.map((x) => x.toFixed(1))}`);
  assert.ok(a.gunfire[2] > 0.5 && a.gunfire[8] < 0.1, 'gunfire');
  const r = hudReframe(a.hudBoxes);
  assert.ok(r.scale > 1 && r.scale <= 1.6, `scale ${r.scale}`);
  // window must not touch the corner boxes
  const half = 0.5 / r.scale;
  for (const b of a.hudBoxes.filter((x) => x.w * x.h > 0.03 || Math.abs(x.x - 0.5) > 0.2))
    assert.ok(!(b.x < r.cx + half && b.x + b.w > r.cx - half && b.y < r.cy + half && b.y + b.h > r.cy - half), 'box excluded');
});

test('concept + timeline build + export (cinematic, HUD removal, no gunfire shots)', async () => {
  const p0 = createProject('t', '16:9', 30);
  const H = await addMedia(p0, hudClip());
  const A = await addMedia(p0, media.clipA);
  const M = await addMedia(p0, media.music, 'music');
  const analyses = { [H.id]: analyze(H.path, H.duration), [A.id]: analyze(A.path, A.duration) };
  const style = parseStyle('cinematic 20s trailer, title "TEST ISLAND", code 1111-2222-3333', { mode: 'cinematic', duration: 30, aspect: '16:9' });
  const concept = buildConcept(style, [{ media: H, analysis: analyses[H.id] }, { media: A, analysis: analyses[A.id] }], M.id);
  assert.ok(concept.sections.length >= 4);
  assert.ok(concept.shots.length >= 4);
  const picked = concept.shots.map((s) => concept.candidates.find((c) => c.id === s.candidateId)!);
  assert.ok(picked.every((c) => c.gunfire < 0.35), 'no gunfire shots picked');
  const proj = buildTrailerProject(p0, concept, { fps: 30, beats: [], analyses });
  assert.ok(Math.abs(projectDuration(proj) - 20) < 0.6, `duration ${projectDuration(proj)}`);
  const hudShots = Object.values(proj.clips).filter((c) => c.mediaId === H.id && c.kind === 'video');
  if (hudShots.length) assert.ok(hudShots.every((c) => c.transform.scale.value > 1), 'HUD shots reframed');
  assert.ok(Object.values(proj.clips).some((c) => c.kind === 'adjust'), 'letterbox');
  assert.ok(Object.values(proj.clips).some((c) => c.text?.text === '1111-2222-3333'), 'island code card');
  // render it (text layers skipped in node: no canvas)
  const out = tmpOut('auto.mp4');
  const preset = { ...BUILTIN_PRESETS.find((x) => x.id === 'draft')!, width: 640, height: 360, fps: 30 };
  for (const c of Object.values(proj.clips)) if (c.kind === 'text') delete proj.clips[c.id];
  await runExport(proj, { id: 'a', kind: 'video', outputPath: out, preset, rangeStart: 0, rangeEnd: projectDuration(proj), normalizeLoudness: false, targetLufs: -14, label: '' }, { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-')) });
  assert.ok(Math.abs(probeJson(out).duration - projectDuration(proj)) < 0.2);
});

test('AI answers are merged safely', () => {
  const style = parseStyle('hype 20s', { mode: 'gameplay', duration: 20, aspect: '16:9' });
  const base = buildConcept(style, [], undefined);
  base.candidates = [
    { id: 'm@1', mediaId: 'm', mediaName: 'x', srcIn: 1, length: 2, motion: 0.4, loudness: 0.5, peaks: 0.2, hud: 0, gunfire: 0, dark: false, flat: false, action: 0.6, calm: 0.4, quality: 0, flags: [] },
    { id: 'm@4', mediaId: 'm', mediaName: 'x', srcIn: 4, length: 2, motion: 0.4, loudness: 0.5, peaks: 0.2, hud: 0, gunfire: 0, dark: false, flat: false, action: 0.6, calm: 0.4, quality: 0, flags: [] },
  ];
  const merged = applyAiConcept(
    base,
    'Sure! {"title":"T","sections":[{"name":"Hook","duration":5,"shotLength":2,"energy":1,"shots":["m@1","bogus"]},{"name":"End","duration":5,"endCard":true,"shots":[]}]}',
  );
  assert.equal(merged.source, 'ai');
  assert.equal(merged.sections.length, 2);
  assert.ok(Math.abs(merged.sections.reduce((a, s) => a + s.duration, 0) - 20) < 0.01);
  assert.ok(merged.shots.some((s) => s.candidateId === 'm@1'));
  applyAiFrameReview(base.candidates, ['m@1', 'm@4'], '{"frames":[{"i":1,"hud":false,"gunfire":true,"cinematic":3}]}');
  assert.ok(base.candidates[1].flags.includes('gunfire (AI)'));
});

test('logo + thumbnail are used, and the trailer is exactly the requested length', async () => {
  const p0 = createProject('t', '16:9', 30);
  const A = await addMedia(p0, media.clipA);
  const H = await addMedia(p0, hudClip());
  const M = await addMedia(p0, media.music, 'music');
  const logoFile = path.join(MEDIA_DIR, 'logo_alpha.png');
  if (!fs.existsSync(logoFile))
    execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=c=yellow:s=800x300,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(X,100,700)*between(Y,60,240),255,0)'", '-frames:v', '1', logoFile]);
  const thumbFile = path.join(MEDIA_DIR, 'thumb.jpg');
  if (!fs.existsSync(thumbFile)) execFileSync(ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x8040ff:s=1920x1080', '-frames:v', '1', thumbFile]);
  const L = await addMedia(p0, logoFile);
  const T = await addMedia(p0, thumbFile);
  const analyses = { [A.id]: analyze(A.path, A.duration), [H.id]: analyze(H.path, H.duration) };
  for (const len of [15, 37, 60, 120]) {
    for (const mode of ['gameplay', 'cinematic'] as const) {
      const style = parseStyle('epic trailer, title "LOGO TEST"', { mode, duration: len, aspect: '16:9' });
      style.duration = len;
      const concept = buildConcept(style, [{ media: A, analysis: analyses[A.id] }, { media: H, analysis: analyses[H.id] }], M.id);
      concept.logoMediaId = L.id;
      concept.thumbnailMediaId = T.id;
      const proj = buildTrailerProject(p0, concept, { fps: 30, beats: [], analyses });
      const d = projectDuration(proj);
      assert.ok(Math.abs(d - len) <= 1 / 30 + 1e-6, `${mode} ${len}s → ${d}`);
      const logos = Object.values(proj.clips).filter((c) => c.mediaId === L.id);
      assert.ok(logos.length >= 1, `${mode} ${len}s logo used`);
      const end = Object.values(proj.clips).find((c) => c.mediaId === T.id);
      assert.ok(end && Math.abs(end.start + end.duration - d) < 0.05, 'thumbnail fills the end card');
      if (len === 37 && mode === 'cinematic') {
        // the end card renders: thumbnail behind, logo on top (no gunfire/HUD involved)
        const out = tmpOut('logo_end.mp4');
        const preset = { ...BUILTIN_PRESETS.find((x) => x.id === 'draft')!, width: 640, height: 360, fps: 30 };
        for (const c of Object.values(proj.clips)) if (c.kind === 'text') delete proj.clips[c.id];
        await runExport(proj, { id: 'l', kind: 'video', outputPath: out, preset, rangeStart: d - 2, rangeEnd: d, normalizeLoudness: false, targetLufs: -14, label: '' }, { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-')) });
        const logoClip = logos.find((c) => c.start > d - 8)!;
        const cy = Math.round((0.5 + (logoClip.transform.y.value / 1080)) * 360);
        const bg = pixelAt(out, 1.0, 20, 340);
        const fg = pixelAt(out, 1.0, 320, cy);
        assert.ok(bg[2] > bg[1] && bg[0] > 20, `thumbnail behind ${bg}`);
        assert.ok(fg[0] > 150 && fg[1] > 150 && fg[2] < 90, `yellow logo on top ${fg}`);
      }
    }
  }
});

test('auto sound effects land on effects tracks, lined up with cuts and the title reveal', async () => {
  const p0 = createProject('t', '16:9', 30);
  const A = await addMedia(p0, media.clipA);
  const H = await addMedia(p0, hudClip());
  const M = await addMedia(p0, media.music, 'music');
  const S = await addMedia(p0, media.music, 'sfx'); // any audio file stands in for the generated sounds
  const analyses = { [A.id]: analyze(A.path, A.duration), [H.id]: analyze(H.path, H.duration) };
  const style = parseStyle('hype trailer, title "SFX TEST"', { mode: 'gameplay', duration: 30, aspect: '16:9' });
  const concept = buildConcept(style, [{ media: A, analysis: analyses[A.id] }, { media: H, analysis: analyses[H.id] }], M.id);
  concept.musicStart = 2;
  const ids = { whoosh: S.id, 'whoosh-fast': S.id, riser: S.id, boom: S.id, hit: S.id, braam: S.id, glitch: S.id, 'reverse-whoosh': S.id };
  const proj = buildTrailerProject(p0, concept, { fps: 30, beats: [], analyses, sfx: ids });
  const sfxClips = Object.values(proj.clips).filter((c) => c.mediaId === S.id);
  assert.ok(sfxClips.length >= 3, `only ${sfxClips.length} sound effects`);
  for (const c of sfxClips) {
    const tr = proj.tracks.find((t) => t.id === c.trackId)!;
    assert.ok(tr.role === 'sfx' || tr.role === 'voice', `sfx on ${tr.name}`);
  }
  // no two effects overlap on one track
  for (const a of sfxClips) for (const b of sfxClips) if (a !== b && a.trackId === b.trackId) assert.ok(a.start + a.duration <= b.start + 1e-6 || b.start + b.duration <= a.start + 1e-6, 'overlap');
  const music = Object.values(proj.clips).find((c) => c.mediaId === M.id)!;
  assert.equal(music.in, 2, 'music starts 2 s into the song');
});

test('style text: "title reveal" is not a title, "title is X" is', () => {
  assert.equal(parseStyle('epic trailer with a big title reveal', { mode: 'gameplay', duration: 30, aspect: '16:9' }).title, '');
  assert.equal(parseStyle('trailer, title is BLOCK WORLD', { mode: 'gameplay', duration: 30, aspect: '16:9' }).title, 'BLOCK WORLD');
  assert.equal(parseStyle('a map called Zone Wars', { mode: 'gameplay', duration: 30, aspect: '16:9' }).title, 'Zone Wars');
});

test('style text: apostrophes are not quotes', () => {
  assert.equal(parseStyle("don't stop, it's the island's best moments", { mode: 'gameplay', duration: 30, aspect: '16:9' }).title, '');
  assert.equal(parseStyle("trailer for 'BLOCK WORLD', epic", { mode: 'gameplay', duration: 30, aspect: '16:9' }).title, 'BLOCK WORLD');
});
