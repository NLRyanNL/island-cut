// Derived media: reversed clips (rendered in chunks so memory stays low) and freeze frames.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DerivedRequest } from '../../shared/api';
import { cacheDir, mediaKey } from '../paths';
import { runFfmpeg, ffmpegError } from './run';
import { heavyQueue } from './mediaJobs';

const CHUNK = 2; // seconds per reversed chunk

export async function makeDerivedMedia(req: DerivedRequest): Promise<{ path: string }> {
  const key = crypto
    .createHash('sha1')
    .update(`${mediaKey(req.sourcePath)}|${req.op}|${req.srcIn.toFixed(4)}|${(req.srcOut ?? 0).toFixed(4)}`)
    .digest('hex')
    .slice(0, 20);
  const dir = cacheDir('derived');
  if (req.op === 'freeze') {
    const out = path.join(dir, `${key}_freeze.png`);
    if (fs.existsSync(out)) return { path: out };
    const r = await runFfmpeg(['-v', 'error', '-ss', req.srcIn.toFixed(4), '-i', req.sourcePath, '-frames:v', '1', '-y', out + '.part.png']);
    if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
    fs.renameSync(out + '.part.png', out);
    return { path: out };
  }
  // reverse
  const out = path.join(dir, `${key}_reversed.mp4`);
  if (fs.existsSync(out)) return { path: out };
  return heavyQueue.push(async () => {
    const a = Math.max(0, req.srcIn);
    const b = Math.max(a + 0.05, req.srcOut ?? a + 1);
    const work = path.join(dir, `${key}_work`);
    fs.mkdirSync(work, { recursive: true });
    const parts: string[] = [];
    try {
      for (let s = a, i = 0; s < b - 1e-3; s += CHUNK, i++) {
        const len = Math.min(CHUNK, b - s);
        const part = path.join(work, `p${String(i).padStart(5, '0')}.mp4`);
        const r = await runFfmpeg([
          '-v', 'error', '-y', '-ss', s.toFixed(4), '-t', len.toFixed(4), '-i', req.sourcePath,
          '-vf', 'reverse', '-af', 'areverse',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-pix_fmt', 'yuv420p', '-g', '30',
          '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
          part,
        ], { lowPriority: true });
        if (r.code !== 0) {
          // retry without audio (source may have none)
          const r2 = await runFfmpeg(['-v', 'error', '-y', '-ss', s.toFixed(4), '-t', len.toFixed(4), '-i', req.sourcePath, '-vf', 'reverse', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-pix_fmt', 'yuv420p', part], { lowPriority: true });
          if (r2.code !== 0) throw new Error(ffmpegError(r2.stderr));
        }
        parts.push(part);
      }
      const list = path.join(work, 'list.txt');
      fs.writeFileSync(list, parts.reverse().map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      const r = await runFfmpeg(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out + '.part.mp4']);
      if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
      fs.renameSync(out + '.part.mp4', out);
      return { path: out };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}
