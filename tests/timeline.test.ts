import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, makeClip } from '../shared/defaults';
import { clipsOnTrack, moveClips, placeClip, rippleDelete, splitAt, snapRange, snapTime, tracksOfKind, trimEndTo, trimStartTo, extractAudio, withLinked, clipEnd } from '../shared/timelineOps';
import type { MediaItem, Project } from '../shared/types';

function proj(): { p: Project; v1: string; a1: string; m: MediaItem } {
  const p = createProject('t', '16:9', 30);
  const m: MediaItem = { id: 'm1', kind: 'video', name: 'a.mp4', path: '/a.mp4', folder: 'media', duration: 20, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, audioChannels: 2, sampleRate: 48000, codec: 'h264', fileSize: 1, mtimeMs: 1 };
  p.media[m.id] = m;
  return { p, v1: tracksOfKind(p, 'video').slice(-1)[0].id, a1: tracksOfKind(p, 'audio')[0].id, m };
}

test('split keeps source continuity', () => {
  const { p, v1 } = proj();
  const c = makeClip('video', v1, 2, 6, { mediaId: 'm1', in: 1 });
  placeClip(p, c);
  const [r] = splitAt(p, [c.id], 5);
  const right = p.clips[r];
  assert.equal(p.clips[c.id].duration, 3);
  assert.equal(right.start, 5);
  assert.equal(right.duration, 3);
  assert.equal(right.in, 4);
});

test('trim respects source bounds', () => {
  const { p, v1 } = proj();
  const c = makeClip('video', v1, 5, 5, { mediaId: 'm1', in: 2 });
  placeClip(p, c);
  trimStartTo(p, p.clips[c.id], 1); // would need in = -2 -> clamps at source start
  assert.equal(p.clips[c.id].in, 0);
  assert.equal(p.clips[c.id].start, 3);
  trimEndTo(p, p.clips[c.id], 100);
  assert.equal(clipEnd(p.clips[c.id]), 3 + 20);
});

test('moving onto another clip overwrites it', () => {
  const { p, v1 } = proj();
  const a = makeClip('video', v1, 0, 4, { mediaId: 'm1' });
  const b = makeClip('video', v1, 6, 4, { mediaId: 'm1' });
  placeClip(p, a);
  placeClip(p, b);
  moveClips(p, [{ id: b.id, start: 2, trackId: v1 }]);
  const clips = clipsOnTrack(p, v1);
  assert.equal(clips.length, 2);
  assert.equal(clips[0].duration, 2); // a trimmed to make room
  assert.equal(clips[1].start, 2);
});

test('ripple delete closes the gap', () => {
  const { p, v1 } = proj();
  const a = makeClip('video', v1, 0, 4, { mediaId: 'm1' });
  const b = makeClip('video', v1, 4, 4, { mediaId: 'm1' });
  const c = makeClip('video', v1, 8, 4, { mediaId: 'm1' });
  [a, b, c].forEach((x) => placeClip(p, x));
  rippleDelete(p, [b.id]);
  assert.equal(p.clips[c.id].start, 4);
});

test('extract audio creates a linked audio clip', () => {
  const { p, v1 } = proj();
  const a = makeClip('video', v1, 1, 4, { mediaId: 'm1' });
  placeClip(p, a);
  const au = extractAudio(p, a.id)!;
  assert.ok(au);
  assert.equal(au.kind, 'audio');
  assert.equal(au.start, 1);
  assert.ok(p.clips[a.id].audioDetached);
  assert.deepEqual(withLinked(p, [a.id]).sort(), [a.id, au.id].sort());
  // splitting the video splits the linked audio too
  splitAt(p, [a.id], 3);
  assert.equal(Object.values(p.clips).filter((c) => c.kind === 'audio').length, 2);
});

test('snapping', () => {
  assert.deepEqual(snapTime(4.96, [0, 5, 10], 0.1), [5, 5]);
  assert.deepEqual(snapTime(4.5, [0, 5, 10], 0.1), [4.5, null]);
  // range end snaps
  assert.deepEqual(snapRange(2.95, 2, [0, 5, 10], 0.1), [3, 5]);
});

test('ripple delete keeps linked audio on other tracks in sync', () => {
  const { p, v1 } = proj();
  const a = makeClip('video', v1, 0, 2, { mediaId: 'm1' });
  const b = makeClip('video', v1, 2, 3, { mediaId: 'm1' });
  placeClip(p, a);
  placeClip(p, b);
  const ab = extractAudio(p, b.id)!; // b's audio lives on an audio track, linked to b
  rippleDelete(p, [a.id]);
  assert.equal(p.clips[b.id].start, 0);
  assert.equal(p.clips[ab.id].start, 0, 'linked audio moved along');
});

test('ripple delete of a linked pair closes one gap, not two', () => {
  const { p, v1 } = proj();
  const a = makeClip('video', v1, 0, 2, { mediaId: 'm1' });
  const b = makeClip('video', v1, 2, 3, { mediaId: 'm1' });
  placeClip(p, a);
  placeClip(p, b);
  extractAudio(p, a.id);
  const bAudio = extractAudio(p, b.id)!;
  rippleDelete(p, [a.id]);
  assert.equal(p.clips[b.id].start, 0);
  assert.equal(p.clips[bAudio.id].start, 0);
});
