// Draws a clip's filmstrip (video) or waveform (audio) for the visible part of the clip only.
import React, { useEffect, useRef } from 'react';
import type { Clip, MediaItem, WaveformData } from '../../../shared/types';
import type { ProxyInfo } from '../../../shared/api';
import { sourceTimeAt } from '../../../shared/keyframes';
import { clipGainAt } from '../../../shared/render/buildGraph';
import type { Project } from '../../../shared/types';

const stripImages = new Map<string, HTMLImageElement>();

function stripImage(url: string, onload: () => void): HTMLImageElement | null {
  let img = stripImages.get(url);
  if (!img) {
    img = new Image();
    img.onload = onload;
    img.src = url;
    stripImages.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

export interface ClipCanvasProps {
  clip: Clip;
  media: MediaItem | undefined;
  project: Project;
  proxy?: ProxyInfo;
  waveform?: WaveformData;
  thumb?: string;
  zoom: number;
  /** visible range within the clip in px (relative to clip left) */
  visLeft: number;
  visWidth: number;
  height: number;
  showWave: boolean;
  showStrip: boolean;
}

export function ClipCanvas(props: ClipCanvasProps): React.ReactElement | null {
  const ref = useRef<HTMLCanvasElement>(null);
  const { clip, zoom, visLeft, visWidth, height, waveform, proxy, project } = props;
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(visWidth));
    const h = Math.max(1, Math.round(height));
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // filmstrip
    if (props.showStrip && proxy?.stripUrl && proxy.stripInterval && proxy.stripCount) {
      const img = stripImage(proxy.stripUrl, () => force());
      if (img) {
        const tileW0 = img.naturalWidth / proxy.stripCount;
        const tileH0 = img.naturalHeight;
        const th = h;
        const tw = (tileW0 / tileH0) * th;
        const startSlot = Math.floor(visLeft / tw);
        for (let x = startSlot * tw - visLeft; x < w; x += tw) {
          const local = (visLeft + x) / zoom;
          const src = sourceTimeAt(clip, Math.max(0, Math.min(clip.duration, local)));
          const idx = Math.min(proxy.stripCount - 1, Math.max(0, Math.floor(src / proxy.stripInterval)));
          ctx.drawImage(img, idx * tileW0, 0, tileW0, tileH0, x, 0, tw, th);
        }
      }
    } else if (props.showStrip && props.thumb) {
      const img = stripImage(props.thumb, () => force());
      if (img) {
        const th = h;
        const tw = (img.naturalWidth / img.naturalHeight) * th;
        for (let x = -(visLeft % tw); x < w; x += tw) ctx.drawImage(img, x, 0, tw, th);
      }
    }
    // waveform
    if (props.showWave && waveform) {
      const mid = props.showStrip ? h * 0.72 : h / 2;
      const amp = props.showStrip ? h * 0.26 : h / 2 - 1;
      ctx.fillStyle = props.showStrip ? 'rgba(160,255,200,0.75)' : 'rgba(170,255,210,0.85)';
      const pps = waveform.peaksPerSec;
      for (let x = 0; x < w; x++) {
        const l0 = (visLeft + x) / zoom;
        const l1 = (visLeft + x + 1) / zoom;
        if (l0 > clip.duration) break;
        const s0 = sourceTimeAt(clip, l0);
        const s1 = sourceTimeAt(clip, Math.min(clip.duration, l1));
        const i0 = Math.floor(s0 * pps);
        const i1 = Math.max(i0 + 1, Math.ceil(s1 * pps));
        let pk = 0;
        for (let i = i0; i < i1 && i < waveform.peaks.length; i++) pk = Math.max(pk, waveform.peaks[i]);
        const g = Math.min(2, clipGainAt(project, clip, l0));
        const v = Math.min(1, pk * g) * amp;
        if (v > 0.3) ctx.fillRect(x, mid - v, 1, v * 2);
      }
    }
  });
  return <canvas ref={ref} className="wave" style={{ left: visLeft }} />;
}
