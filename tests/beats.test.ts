import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBeats } from '../shared/beatDetect';

function clickTrack(bpm: number, seconds: number, sr: number, offset = 0.3): Float32Array {
  const s = new Float32Array(Math.floor(seconds * sr));
  const period = 60 / bpm;
  for (let t = offset; t < seconds; t += period) {
    const i0 = Math.floor(t * sr);
    for (let i = 0; i < sr * 0.05 && i0 + i < s.length; i++) s[i0 + i] += Math.sin(i * 0.3) * Math.exp(-i / (sr * 0.01)) * 0.8;
  }
  // add some noise + a pad
  for (let i = 0; i < s.length; i++) s[i] += (Math.random() - 0.5) * 0.02 + 0.05 * Math.sin((2 * Math.PI * 220 * i) / sr);
  return s;
}

for (const bpm of [95, 128, 150]) {
  test(`detects ${bpm} BPM click track`, () => {
    const sr = 22050;
    const r = detectBeats(clickTrack(bpm, 30, sr), sr);
    const ok = [bpm, bpm * 2, bpm / 2].some((b) => Math.abs(r.bpm - b) / b < 0.03);
    assert.ok(ok, `bpm ${r.bpm}`);
    // beats should align with clicks within 30ms
    const period = 60 / bpm;
    const errs = r.beats.slice(2, -2).map((b) => {
      const k = Math.round((b - 0.3) / period);
      return Math.abs(b - (0.3 + k * period));
    });
    const med = errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)];
    assert.ok(med < 0.03, `median error ${med}`);
    assert.ok(r.downbeats.length >= r.beats.length / 4 - 1);
  });
}
