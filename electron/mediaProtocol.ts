// "media://" protocol: serves local files to the renderer with HTTP Range support,
// which <video>/<audio> need for seeking. Only files the app has registered are served.
import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export const MEDIA_SCHEME = 'media';

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
    },
  ]);
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  json: 'application/json',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/** media://f/<encodeURIComponent(absolutePath)> */
export function mediaUrl(abs: string): string {
  return `${MEDIA_SCHEME}://f/${encodeURIComponent(abs)}`;
}

export function handleMediaProtocol(isAllowed: (file: string) => boolean): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      const file = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (!isAllowed(file)) return new Response('Forbidden', { status: 403 });
      const st = await fs.promises.stat(file);
      const size = st.size;
      const ext = path.extname(file).slice(1).toLowerCase();
      const type = MIME[ext] ?? 'application/octet-stream';
      const range = req.headers.get('range');
      const baseHeaders: Record<string, string> = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      };
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (m && !m[1] && m[2]) {
          // suffix range: last N bytes
          start = Math.max(0, size - parseInt(m[2], 10));
          end = size - 1;
        }
        if (start >= size || end < start) {
          return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } });
        }
        end = Math.min(end, size - 1);
        const stream = fs.createReadStream(file, { start, end });
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
        });
      }
      const stream = fs.createReadStream(file);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(size) },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
