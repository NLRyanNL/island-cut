import React, { useEffect, useRef } from 'react';
import { timecode } from '../../../shared/time';

const STEPS = [1 / 60, 1 / 30, 1 / 10, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function Ruler(props: { width: number; zoom: number; scrollX: number; fps: number }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  const { width, zoom, scrollX, fps } = props;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 28;
    cv.width = Math.max(1, Math.round(width * dpr));
    cv.height = h * dpr;
    cv.style.width = width + 'px';
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    // label spacing ~ 90px
    let major = STEPS.find((s) => s * zoom >= 90) ?? 600;
    if (major < 1 / fps) major = 1 / fps;
    const minor = major / (major >= 1 ? 5 : 2);
    const t0 = Math.floor(scrollX / minor) * minor;
    ctx.strokeStyle = '#4a4f5b';
    ctx.fillStyle = '#9aa0ab';
    ctx.font = '10px Consolas, monospace';
    ctx.beginPath();
    for (let t = t0; ; t += minor) {
      const x = (t - scrollX) * zoom;
      if (x > width) break;
      if (x < -1) continue;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(Math.round(x) + 0.5, isMajor ? 12 : 20);
      ctx.lineTo(Math.round(x) + 0.5, h);
      if (isMajor) {
        const tc = timecode(t, fps);
        const label = major >= 1 ? tc.slice(3, 8) : tc.slice(3);
        ctx.fillText(label, x + 3, 10);
      }
    }
    ctx.stroke();
  }, [width, zoom, scrollX, fps]);
  return <canvas ref={ref} />;
}
