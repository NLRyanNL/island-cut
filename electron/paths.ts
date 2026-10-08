import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let root = '';

export function setCacheRoot(dir: string): void {
  root = dir;
  for (const d of ['proxies', 'thumbs', 'strips', 'waveforms', 'derived', 'jobs', 'autosave', 'analysis', 'luts', 'sfx']) fs.mkdirSync(path.join(root, d), { recursive: true });
}

export function cacheDir(sub: string): string {
  if (!root) throw new Error('cache root not set');
  return path.join(root, sub);
}

/** Stable key for a media file (path + size + mtime), so caches survive renames of projects. */
export function mediaKey(file: string): string {
  let sig = file;
  try {
    const st = fs.statSync(file);
    sig += `|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    /* missing file: key on path only */
  }
  return crypto.createHash('sha1').update(sig).digest('hex').slice(0, 20);
}

export function jobDir(id: string): string {
  const d = path.join(cacheDir('jobs'), id.replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
