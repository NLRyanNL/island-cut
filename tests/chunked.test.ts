// Very long timelines are rendered in parts when the FFmpeg command line would get too long
// (Windows limit). Forces a tiny limit and checks the joined result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject, clipFromMedia, BUILTIN_PRESETS } from '../shared/defaults';
import { placeClip, tracksOfKind } from '../shared/timelineOps';
import { runExport } from '../electron/export/exporter';
import { ensureTestMedia, addMedia, probeJson, pixelAt, tmpOut, near, volumeAt } from './helpers';
import { uid } from '../shared/time';

const media = ensureTestMedia();

test('chunked export (command line too long) joins parts seamlessly', async () => {
  const p = createProject('t', '16:9', 30);
  const v1 = tracksOfKind(p, 'video').find((x) => x.name === 'V1')!;
  const G = await addMedia(p, media.green);
  const B = await addMedia(p, media.clipB);
  for (let i = 0; i < 6; i++) {
    const c = clipFromMedia(i % 2 ? B : G, v1.id, i, 30);
    c.duration = 1;
    placeClip(p, c);
  }
  const out = tmpOut('chunked.mp4');
  const preset = { ...BUILTIN_PRESETS.find((x) => x.id === 'draft')!, width: 640, height: 360, fps: 30 };
  process.env.UTS_CMD_LIMIT = '900';
  const msgs: string[] = [];
  try {
    await runExport(
      p,
      { id: uid('j'), kind: 'video', outputPath: out, preset, rangeStart: 0, rangeEnd: 6, normalizeLoudness: true, targetLufs: -14, label: 't' },
      { jobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uts-job-')), onProgress: (pr) => pr.message && msgs.push(pr.message) },
    );
  } finally {
    delete process.env.UTS_CMD_LIMIT;
  }
  assert.ok(msgs.some((m) => /parts/.test(m)), 'used the chunked path');
  const info = probeJson(out);
  assert.ok(Math.abs(info.duration - 6) < 0.1, `duration ${info.duration}`);
  const v = info.streams.find((s) => s.codec_type === 'video')!;
  assert.equal(Number(v.nb_frames), 180);
  for (let i = 0; i < 6; i++) {
    const px = pixelAt(out, i + 0.5, 320, 30);
    if (i % 2) assert.ok(near(px, [0x20, 0x60, 0xff], 35), `clip ${i} blue ${px}`);
    else assert.ok(near(px, [0, 255, 0], 35), `clip ${i} green ${px}`);
  }
  // last frame present
  assert.ok(near(pixelAt(out, 5.95, 320, 30), [0x20, 0x60, 0xff], 35), 'last frame');
  assert.ok(volumeAt(out, 1.5, 1) > -40, 'audio present');
});
