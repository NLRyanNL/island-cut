// Every built-in sound effect renders with the bundled FFmpeg, has the right length and is audible
// but not clipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SFX_RECIPES } from '../electron/sfx';
import { runFfmpeg } from '../electron/ffmpeg/run';
import { probeJson } from './helpers';

test('built-in sound effects render', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uts-sfx-'));
  for (const r of SFX_RECIPES) {
    const file = path.join(dir, `${r.id}.wav`);
    const res = await runFfmpeg(['-y', '-filter_complex', `${r.graph}[o]`, '-map', '[o]', '-ar', '48000', '-c:a', 'pcm_s16le', file], {});
    assert.equal(res.code, 0, `${r.id}: ${res.stderr.slice(-400)}`);
    const d = probeJson(file).duration;
    const want = Number(/d=([\d.]+)/.exec(r.graph)![1]);
    assert.ok(Math.abs(d - want) < 0.05, `${r.id} duration ${d} vs ${want}`);
    const out = (await runFfmpeg(['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {})).stderr;
    const max = Number(/max_volume: (-?[\d.]+) dB/.exec(out)?.[1]);
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(out)?.[1]);
    assert.ok(max <= 0 && max > -12, `${r.id} peak ${max} dB`);
    assert.ok(mean > -45, `${r.id} mean ${mean} dB`);
  }
});
