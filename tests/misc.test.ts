import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../electron/updates';
import { skipIntroOffset, clampMusicStart } from '../shared/music';

test('version comparison for the update checker', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('v1.0.0', '0.9.12') > 0);
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0);
  assert.ok(compareVersions('0.1.0', '0.1.1') < 0);
});

test('music: skip a quiet intro, keep the trailer inside the song', () => {
  const pps = 10;
  const peaks = [...Array(80).fill(0.05), ...Array(200).fill(0.8)]; // 8 s quiet, then loud
  const t = skipIntroOffset(peaks, pps);
  assert.ok(t >= 7 && t <= 8, `offset ${t}`);
  assert.equal(skipIntroOffset(Array(100).fill(0.7), pps), 0);
  assert.equal(clampMusicStart(50, 60, 30), 30);
  assert.equal(clampMusicStart(-3, 60, 30), 0);
  assert.equal(clampMusicStart(10, 20, 30), 0);
});
