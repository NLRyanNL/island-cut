// Turns a timeline into an FFmpeg command: one input per clip, a filter_complex script that
// composites all visual layers bottom-to-top on a background, and an audio mix.
//
// Per visual clip:   seek+trim source -> map timestamps to timeline (setpts) -> constant fps ->
//                    scale/fit -> rgba -> color LUT/vignette -> sendcmd-driven animated filters
//                    (blur, rgb shift, dip colour, opacity, rotation, size) -> overlay at x(t),y(t)
// Per audio clip:    seek+trim -> speed (atempo) -> volume envelope -> delay to timeline position -> amix
//
// Animated values are sampled per output frame from shared/evaluate.ts (the same code the preview uses).
import type { Clip, MediaItem, Project, Track } from '../types';
import { activeRange, contentSize, evaluateClip, visualTracksBottomUp, clipHasAudio, sourceTimeClamped, LayerState } from '../evaluate';
import { clipEnd, clipsOnTrack } from '../timelineOps';
import { evalKeys, hasRamp, sourceOffsetAt } from '../keyframes';
import { buildClipLut, isNeutralColor, lutToCubeText, vignetteAngle, CubeLut, colorSig } from '../color';
import { fmt, isConstant, pwlExpr, simplify, Pt } from './expr';
import { clamp, EPS } from '../time';

export interface TextAsset {
  /** e.g. "text_3_%05d.png" relative to the job dir (PNG sequence) or a single still PNG. */
  pattern: string;
  sequence: boolean;
  /** timeline time of the first frame */
  start: number;
  duration: number;
  fps: number;
}

export interface BuildInput {
  project: Project;
  rangeStart: number;
  rangeEnd: number;
  outWidth: number;
  outHeight: number;
  fps: number;
  video: boolean;
  audio: boolean;
  /** Only include these clips (e.g. audio export of one clip). */
  onlyClipIds?: string[];
  /** Path to use for a media item (original for export, proxy for previews). */
  mediaPath: (m: MediaItem) => string;
  /** Rendered text layers, by clip id. */
  textAssets?: Record<string, TextAsset>;
  /** Parsed .cube LUTs, by absolute path. */
  userLuts?: Record<string, CubeLut>;
  /** Gain multiplier for music-role tracks at timeline time t (auto-ducking). */
  duckGainAt?: (t: number) => number;
  /** Loudness normalisation stage appended to the audio mix. */
  loudnorm?: { mode: 'measure' | 'apply'; target: number; measured?: LoudnormMeasure };
  /** Output pixel format: video (yuv420p) or still image (rgb24). */
  pixelFormat?: 'yuv420p' | 'rgb24';
  /** Use the clip's proxy instead of exact original-frame seeking. */
}

export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export interface BuildResult {
  args: string[];
  filterScript: string;
  files: Record<string, string>;
  videoLabel?: string;
  audioLabel?: string;
  duration: number;
  warnings: string[];
}

interface InputSpec {
  args: string[];
}

const f6 = (n: number) => fmt(n, 6);

/** sendcmd target prefixes -> filter class names */
const FILTER_CLASS: Record<string, string> = { gb: 'gblur', rs: 'rgbashift', db: 'drawbox', cc: 'colorchannelmixer', rt: 'rotate', sc: 'scale' };

function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2.0 + EPS) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5 - EPS) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-4) out.push(`atempo=${fmt(s, 5)}`);
  return out;
}

function trackIsAudible(t: Track | undefined): boolean {
  return !!t && !t.muted;
}

/** Linear gain of a clip's audio at clip-local time (volume, keyframes, fades, track volume). */
export function clipGainAt(p: Project, c: Clip, local: number): number {
  const tr = p.tracks.find((t) => t.id === c.trackId);
  let g = c.volume * (tr?.volume ?? 1);
  if (c.volumeKeys && c.volumeKeys.length >= 2) g *= evalKeys(c.volumeKeys, local);
  if (c.fadeIn > EPS && local < c.fadeIn) g *= clamp(local / c.fadeIn, 0, 1);
  if (c.fadeOut > EPS && local > c.duration - c.fadeOut) g *= clamp((c.duration - local) / c.fadeOut, 0, 1);
  return Math.max(0, g);
}

export function buildGraph(inp: BuildInput): BuildResult {
  const p = inp.project;
  const R0 = inp.rangeStart;
  const R1 = inp.rangeEnd;
  const DUR = Math.max(1 / inp.fps, R1 - R0);
  const fps = inp.fps;
  const W = p.settings.width;
  const H = p.settings.height;
  // Composite canvas: project frame scaled to fit the output size.
  const k = Math.min(inp.outWidth / W, inp.outHeight / H);
  const CW = Math.max(2, Math.round((W * k) / 2) * 2);
  const CH = Math.max(2, Math.round((H * k) / 2) * 2);
  const only = inp.onlyClipIds ? new Set(inp.onlyClipIds) : null;
  const inputs: InputSpec[] = [];
  const graph: string[] = [];
  const files: Record<string, string> = {};
  const warnings: string[] = [];
  const lutFiles = new Map<string, string>();

  const addInput = (args: string[]): number => {
    inputs.push({ args });
    return inputs.length - 1;
  };

  let videoLabel: string | undefined;
  let audioLabel: string | undefined;
  // video inputs by clip id: the clip's own audio reuses the same input when it fits inside it
  // (halves the number of inputs, which keeps the Windows command line short)
  const videoInputs = new Map<string, { idx: number; seek: number; len: number }>();

  // ------------------------------------------------------------------ VIDEO
  if (inp.video) {
    let cur = 'bg0';
    let n = 0;
    const bg = p.settings.backgroundColor || '#000000';
    graph.push(`color=c=${bg.replace('#', '0x')}:s=${CW}x${CH}:r=${fps}:d=${f6(DUR)},format=rgba[${cur}]`);

    const tracks = visualTracksBottomUp(p);
    tracks.forEach((track, ti) => {
      if (track.hidden) return;
      const clips = clipsOnTrack(p, track.id);
      clips.forEach((c, ci) => {
        if (only && !only.has(c.id)) return;
        if (c.kind === 'audio') return;
        const ar = activeRange(p, c);
        const tlA = Math.max(ar.a, R0);
        const tlB = Math.min(ar.b, R1);
        if (tlB - tlA < 0.5 / fps) return;

        if (c.kind === 'adjust') {
          const a = c.adjust;
          if (a?.letterbox) {
            const ratio = a.letterboxRatio || 2.39;
            const bar = Math.max(0, Math.round((CH - CW / ratio) / 2));
            if (bar > 0) {
              const lf0 = Math.ceil((tlA - R0) * fps - 1e-6);
              const lf1 = Math.ceil((tlB - R0) * fps - 1e-6);
              const en = `enable='between(t,${f6((lf0 - 0.5) / fps)},${f6((lf1 - 0.5) / fps)})'`;
              const next = `bg${++n}`;
              graph.push(
                `[${cur}]drawbox=x=0:y=0:w=iw:h=${bar}:t=fill:color=black:${en},drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:t=fill:color=black:${en}[${next}]`,
              );
              cur = next;
            }
          }
          return;
        }

        const id = `c${n + 1}`;
        // Sample the layer state per output frame.
        const f0 = Math.ceil((tlA - R0) * fps - 1e-6);
        const f1 = Math.ceil((tlB - R0) * fps - 1e-6); // exclusive
        if (f1 <= f0) return;
        const states: (LayerState | null)[] = [];
        for (let f = f0; f < f1; f++) states.push(evaluateClip(p, c, track, ti * 10000 + ci, R0 + f / fps));
        if (!states.some((s) => s && s.opacity > 0.001)) return;
        const frameT = (i: number) => (f0 + i) / fps; // relative to R0
        // Boundaries half a frame before the first/after-last frame: robust against 6-decimal rounding.
        const wA = f6((f0 - 0.5) / fps);
        const wB = f6((f1 - 0.5) / fps);

        // ---------- source input
        let srcLabel: string;
        const m = c.mediaId ? p.media[c.mediaId] : undefined;
        let chain: string[] = [];
        if (c.kind === 'video') {
          if (!m) {
            warnings.push(`Clip "${c.name}" has no media`);
            return;
          }
          const sA = sourceTimeClamped(p, c, tlA - c.start);
          const sB = sourceTimeClamped(p, c, tlB - c.start);
          const margin = 2 / Math.max(1, m.fps || 30) + 1 / fps;
          const seek = Math.max(0, sA);
          const len = Math.max(1 / fps, sB - seek + margin);
          const idx = addInput(['-ss', f6(seek), '-t', f6(len), '-i', inp.mediaPath(m)]);
          srcLabel = `${idx}:v`;
          videoInputs.set(c.id, { idx, seek, len });
          // timestamp mapping: input time T (seconds since seek) -> timeline time (relative to R0)
          let firstTl: number;
          if (!hasRamp(c)) {
            const sp = c.speed || 1;
            // timeline time where source == seek
            const localAtSeek = (seek - c.in) / sp;
            firstTl = c.start + localAtSeek - R0;
            chain.push(`setpts='(T/${fmt(sp, 6)}+${f6(firstTl)})/TB'`);
          } else {
            // sample inverse mapping (source offset -> timeline) on a fine grid
            const pts: Pt[] = [];
            const startLocal = Math.max(0, tlA - c.start);
            const endLocal = Math.min(c.duration, tlB - c.start) + 1 / fps;
            const step = 1 / (fps * 2);
            for (let l = startLocal; l <= endLocal + EPS; l += step) {
              const src = sourceTimeClamped(p, c, l);
              pts.push({ t: src - seek, v: c.start + l - R0 });
            }
            // ensure strictly increasing in t
            const mono: Pt[] = [];
            for (const pt of pts) if (!mono.length || pt.t > mono[mono.length - 1].t + 1e-6) mono.push(pt);
            firstTl = mono.length ? mono[0].v : tlA - R0;
            const simp = simplify(mono, 0.25 / fps);
            // extrapolate past the end with the final slope
            const expr = pwlExpr(simp, 'T');
            chain.push(`setpts='(${expr})/TB'`);
          }
          chain.push(`fps=${fps}:round=near:start_time=${f6(f0 / fps)}`);
          // Fill missing handles (transition overlap beyond the source) by cloning edge frames.
          const startPad = firstTl - (tlA - R0);
          const lastSrcTl = (() => {
            if (hasRamp(c)) return tlB - R0;
            const sp = c.speed || 1;
            const srcEnd = Math.min(m.duration, seek + len);
            return c.start + (srcEnd - c.in) / sp - R0;
          })();
          const endPad = tlB - R0 - lastSrcTl;
          // (missing frames at the START are already filled by the fps filter's start_time, which
          // repeats the first frame back to f0; padding them again here would delay the whole clip)
          void startPad;
          if (endPad > 0.5 / fps) chain.push(`tpad=stop_mode=clone:stop_duration=${f6(Math.max(0, endPad) + 1 / fps)}`);
          chain.push(`trim=start_pts=${f0}:end_pts=${f1}`);
        } else if (c.kind === 'image') {
          if (!m) return;
          const idx = addInput(['-loop', '1', '-framerate', String(fps), '-t', f6(tlB - tlA + 2 / fps), '-i', inp.mediaPath(m)]);
          srcLabel = `${idx}:v`;
          chain.push(`setpts=PTS-STARTPTS+${f6(f0 / fps)}/TB`, `fps=${fps}:round=near:start_time=${f6(f0 / fps)}`, `trim=start_pts=${f0}:end_pts=${f1}`);
        } else if (c.kind === 'text') {
          const asset = inp.textAssets?.[c.id];
          if (!asset) {
            warnings.push(`Text clip "${c.name}" was not rendered`);
            return;
          }
          let idx: number;
          if (asset.sequence) {
            idx = addInput(['-framerate', String(asset.fps), '-start_number', '0', '-i', asset.pattern]);
            srcLabel = `${idx}:v`;
            chain.push(`setpts=PTS-STARTPTS+${f6(asset.start - R0)}/TB`);
          } else {
            idx = addInput(['-loop', '1', '-framerate', String(fps), '-t', f6(tlB - tlA + 2 / fps), '-i', asset.pattern]);
            srcLabel = `${idx}:v`;
            chain.push(`setpts=PTS-STARTPTS+${f6(tlA - R0)}/TB`);
          }
          chain.push(`fps=${fps}:round=near:start_time=${f6(f0 / fps)}`, `trim=start_pts=${f0}:end_pts=${f1}`);
        } else {
          return;
        }

        // ---------- HUD clean-up (fill regions from their surroundings), in source pixels
        if (c.cleanup?.length && m && m.width > 8 && m.height > 8) {
          for (const b of c.cleanup.slice(0, 4)) {
            const x = Math.max(1, Math.floor(b.x * m.width));
            const y = Math.max(1, Math.floor(b.y * m.height));
            const w = Math.min(m.width - 2 - x, Math.ceil(b.w * m.width));
            const h = Math.min(m.height - 2 - y, Math.ceil(b.h * m.height));
            if (w >= 2 && h >= 2) chain.push(`delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
          }
        }

        // ---------- geometry
        const valid = states.filter(Boolean) as LayerState[];
        const ref = valid[0];
        const sizeW = (s: LayerState) => s.w * k;
        const sizeH = (s: LayerState) => s.h * k;
        const rotUsed = valid.some((s) => Math.abs(s.rotation) > 0.01);
        const wMax = Math.min(CW * 4, Math.max(...valid.map(sizeW)));
        const hMax = Math.min(CH * 4, Math.max(...valid.map(sizeH)));
        const sizeAnimated = valid.some((s) => Math.abs(sizeW(s) - sizeW(ref)) > 0.5 || Math.abs(sizeH(s) - sizeH(ref)) > 0.5);
        const bw = Math.max(2, Math.round(wMax));
        const bh = Math.max(2, Math.round(hMax));
        chain.push(`scale=${bw}:${bh}:in_color_matrix=auto:flags=bicubic`, 'format=rgba');

        // ---------- color
        if (c.kind !== 'text' && !isNeutralColor(c.color)) {
          const user = c.color.lutPath ? inp.userLuts?.[c.color.lutPath] ?? null : null;
          if (c.color.lutPath && !user) warnings.push(`LUT not found for "${c.name}": ${c.color.lutPath}`);
          const sig = colorSig(c.color);
          let fname = lutFiles.get(sig);
          if (!fname) {
            fname = `lut_${lutFiles.size}.cube`;
            files[fname] = lutToCubeText(buildClipLut(c.color, user));
            lutFiles.set(sig, fname);
          }
          chain.push(`lut3d=file=${fname}:interp=trilinear`);
        }
        if (c.kind !== 'text' && c.color.vignette > 0.001) chain.push(`vignette=angle=${fmt(vignetteAngle(c.color.vignette), 5)}`);

        // ---------- wipe / shape reveal mask (geq alpha, only inside the transition window)
        const maskFrames = states.map((s) => s?.mask);
        const m0 = maskFrames.find(Boolean);
        if (m0) {
          const pts: Pt[] = states.map((s, i) => ({ t: frameT(i), v: s?.mask ? s.mask.p : 1 }));
          const P = pwlExpr(simplify(pts, 0.002), 'T');
          const F = fmt(Math.max(1e-4, m0.feather), 5);
          let D: string;
          switch (m0.kind) {
            case 'linear': {
              const a = (m0.angle * Math.PI) / 180;
              const cs = Math.cos(a);
              const sn = Math.sin(a);
              const r = 0.5 * (Math.abs(cs) + Math.abs(sn));
              D = `((X/W-0.5)*(${fmt(cs, 6)})+(Y/H-0.5)*(${fmt(sn, 6)})+${fmt(r, 6)})/${fmt(2 * r, 6)}`;
              break;
            }
            case 'circle':
              D = 'hypot(X-W/2,Y-H/2)/(0.5*hypot(W,H))';
              break;
            case 'diamond':
              D = 'abs(X/W-0.5)+abs(Y/H-0.5)';
              break;
            case 'clock':
              D = 'mod(atan2(X-W/2,H/2-Y)/(2*PI)+1,1)';
              break;
            default: {
              const Q = `${m0.angle === 90 ? 'Y/H' : 'X/W'}*${m0.bands}`;
              D = `(${Q}-floor(${Q}))`;
            }
          }
          const wins: string[] = [];
          let runStart = -1;
          maskFrames.forEach((mk, i) => {
            const on = !!mk;
            if (on && runStart < 0) runStart = i;
            if ((!on || i === maskFrames.length - 1) && runStart >= 0) {
              const endI = on ? i + 1 : i;
              wins.push(`between(t,${f6(frameT(runStart) - 0.25 / fps)},${f6(frameT(endI) - 0.5 / fps)})`);
              runStart = -1;
            }
          });
          const A = `alpha(X,Y)*clip((-${F}+(${P})*(1+2*${F})-(${D}))/${F},0,1)`;
          chain.push(`format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${A}':enable='${wins.join('+')}',format=rgba`);
        }

        // ---------- animated in-chain filters via sendcmd
        const blurUsed = valid.some((s) => s.blur > 0.05);
        const shiftUsed = valid.some((s) => s.rgbShift > 0.3);
        const dipUsed = valid.some((s) => s.dipAmount > 0.002);
        const noiseUsed = valid.some((s) => s.noise > 0.01);
        const opacities = states.map((s) => (s ? s.opacity : 0));
        const opacityAnimated = opacities.some((o) => Math.abs(o - opacities[0]) > 0.002);
        const opacityConst = opacities[0];
        const D = rotUsed ? Math.ceil(Math.hypot(bw, bh) / 2) * 2 : 0;

        const cmds: string[] = [];
        const last: Record<string, string> = {};
        const emit = (i: number, target: string, cmd: string, val: string, out: string[]) => {
          const key = `${target}.${cmd}`;
          if (i > 0 && last[key] === val) return;
          last[key] = val;
          // FFmpeg 6.0 names an instance "id", FFmpeg 6.1+/7 names it "filter@id": address both
          // (the one that does not exist is ignored), so any bundled FFmpeg version works.
          const cls = FILTER_CLASS[target.slice(0, 2)];
          out.push(`${target} ${cmd} ${val}`);
          if (cls) out.push(`${cls}@${target} ${cmd} ${val}`);
        };
        states.forEach((s, i) => {
          const parts: string[] = [];
          const st = s ?? ref;
          if (blurUsed) {
            const sigma = s ? Math.max(0, s.blur * k * (bw / Math.max(1, sizeW(st)))) : 0;
            emit(i, `gb${id}`, 'sigma', fmt(sigma, 2), parts);
            emit(i, `gb${id}`, 'sigmaV', s && s.blurHorizontalOnly ? '0.01' : fmt(sigma, 2), parts);
          }
          if (shiftUsed) {
            const sh = s ? Math.round(s.rgbShift * k) : 0;
            emit(i, `rs${id}`, 'rh', String(sh), parts);
            emit(i, `rs${id}`, 'bh', String(-sh), parts);
          }
          if (dipUsed) {
            const a = s ? s.dipAmount : 0;
            const col = s ? s.dipColor : [0, 0, 0];
            const hex = '0x' + col.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            emit(i, `db${id}`, 'color', `${hex}@${fmt(a, 3)}`, parts);
          }
          if (opacityAnimated) emit(i, `cc${id}`, 'aa', fmt(s ? s.opacity : 0, 3), parts);
          if (rotUsed) emit(i, `rt${id}`, 'angle', fmt(((s ? s.rotation : 0) * Math.PI) / 180, 5), parts);
          if (sizeAnimated) {
            const sw = s ? sizeW(s) : sizeW(ref);
            const sh = s ? sizeH(s) : sizeH(ref);
            if (rotUsed) {
              const kk = sw / Math.max(1, wMax);
              const dd = Math.max(2, Math.round(D * kk));
              emit(i, `sc${id}`, 'w', String(dd), parts);
              emit(i, `sc${id}`, 'h', String(dd), parts);
            } else {
              emit(i, `sc${id}`, 'w', String(Math.max(2, Math.round(sw))), parts);
              emit(i, `sc${id}`, 'h', String(Math.max(2, Math.round(sh))), parts);
            }
          }
          if (parts.length) cmds.push(`${f6(Math.max(0, frameT(i) - 0.25 / fps))} [enter] ${parts.join(', ')};`);
        });
        if (cmds.length) {
          const fname = `cmd_${id}.txt`;
          files[fname] = cmds.join('\n') + '\n';
          chain.push(`sendcmd=f=${fname}`);
        }
        if (blurUsed) chain.push(`gblur@gb${id}=sigma=0:steps=2`);
        if (shiftUsed) chain.push(`rgbashift@rs${id}=rh=0:bh=0:edge=smear`);
        if (noiseUsed) {
          const wins: string[] = [];
          let runStart = -1;
          states.forEach((s, i) => {
            const on = !!s && s.noise > 0.01;
            if (on && runStart < 0) runStart = i;
            if ((!on || i === states.length - 1) && runStart >= 0) {
              const endI = on ? i + 1 : i;
              wins.push(`between(t,${f6(frameT(runStart))},${f6(frameT(endI) - 0.5 / fps)})`);
              runStart = -1;
            }
          });
          chain.push(`format=gbrap,noise=alls=28:allf=t+u:enable='${wins.join('+')}',format=rgba`);
        }
        if (dipUsed) chain.push(`drawbox@db${id}=x=0:y=0:w=iw:h=ih:t=fill:color=black@0`);
        if (opacityAnimated) chain.push(`colorchannelmixer@cc${id}=aa=1`);
        else if (opacityConst < 0.999) chain.push(`colorchannelmixer=aa=${fmt(opacityConst, 4)}`);
        if (rotUsed) chain.push(`rotate@rt${id}=angle=0:ow=${D}:oh=${D}:fillcolor=0x00000000:bilinear=1`);
        if (sizeAnimated) chain.push(`scale@sc${id}=w=${rotUsed ? D : bw}:h=${rotUsed ? D : bh}:eval=frame:flags=bicubic`);

        // ---------- position (overlay x/y as expressions of t)
        const xs: Pt[] = [];
        const ys: Pt[] = [];
        states.forEach((s, i) => {
          const st = s ?? ref;
          let ow: number;
          let oh: number;
          if (rotUsed) {
            const kk = sizeW(st) / Math.max(1, wMax);
            ow = oh = Math.max(2, Math.round(sizeAnimated ? D * kk : D));
          } else {
            ow = sizeAnimated ? Math.max(2, Math.round(sizeW(st))) : bw;
            oh = sizeAnimated ? Math.max(2, Math.round(sizeH(st))) : bh;
          }
          xs.push({ t: frameT(i), v: st.cx * k - ow / 2 });
          ys.push({ t: frameT(i), v: st.cy * k - oh / 2 });
        });
        const xExpr = isConstant(xs, 0.25) ? fmt(Math.round(xs[0].v), 2) : pwlExpr(simplify(xs, 0.25));
        const yExpr = isConstant(ys, 0.25) ? fmt(Math.round(ys[0].v), 2) : pwlExpr(simplify(ys, 0.25));

        graph.push(`[${srcLabel}]${chain.join(',')}[${id}]`);
        const next = `bg${++n}`;
        const en = `enable='between(t,${wA},${wB})'`;
        graph.push(
          `[${cur}][${id}]overlay=x='${xExpr}':y='${yExpr}':eval=frame:format=rgb:eof_action=pass:repeatlast=0:${en}[${next}]`,
        );
        cur = next;
      });
    });

    // final conversion + letterboxing into the output frame if aspect differs
    const finalChain: string[] = [];
    if (CW !== inp.outWidth || CH !== inp.outHeight)
      finalChain.push(`pad=${inp.outWidth}:${inp.outHeight}:(ow-iw)/2:(oh-ih)/2:color=black`);
    if (inp.pixelFormat === 'rgb24') finalChain.push('format=rgb24');
    else finalChain.push('scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p');
    graph.push(`[${cur}]${finalChain.join(',')}[vout]`);
    videoLabel = 'vout';
  }

  // ------------------------------------------------------------------ AUDIO
  if (inp.audio) {
    const mixIn: string[] = [];
    let ai = 0;
    for (const track of p.tracks) {
      if (!trackIsAudible(track)) continue;
      if (track.kind === 'text') continue;
      for (const c of clipsOnTrack(p, track.id)) {
        if (only && !only.has(c.id)) continue;
        if (c.muted || !clipHasAudio(p, c)) continue;
        const m = c.mediaId ? p.media[c.mediaId] : undefined;
        if (!m || !m.hasAudio) continue;
        const a = Math.max(c.start, R0);
        const b = Math.min(clipEnd(c), R1);
        if (b - a < 0.5 / fps) continue;
        const la = a - c.start;
        const lb = b - c.start;
        const srcA = c.in + sourceOffsetAt(c, la);
        const srcB = c.in + sourceOffsetAt(c, lb);
        const seek = Math.max(0, srcA);
        const len = Math.max(0.01, Math.min(m.duration > 0 ? m.duration - seek : Infinity, srcB - seek) + 0.05);
        const vin = videoInputs.get(c.id);
        let idx: number;
        let pre = '';
        if (vin && vin.seek <= seek + 1e-6 && vin.seek + vin.len >= seek + len - 0.06) {
          idx = vin.idx;
          videoInputs.delete(c.id); // each input stream can feed only one link
          const off = seek - vin.seek;
          if (off > 1e-6) pre = `atrim=start=${f6(off)},`;
        } else idx = addInput(['-ss', f6(seek), '-t', f6(len), '-i', inp.mediaPath(m)]);
        const id = `a${ai++}`;
        const ch: string[] = [`${pre}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`, 'asetpts=PTS-STARTPTS'];
        if (hasRamp(c)) {
          // split into short constant-speed segments, each time-stretched with atempo
          const segLen = 0.25;
          const segs: { s0: number; s1: number; sp: number }[] = [];
          for (let l = la; l < lb - 1e-6; l += segLen) {
            const l2 = Math.min(lb, l + segLen);
            const s0 = c.in + sourceOffsetAt(c, l) - seek;
            const s1 = c.in + sourceOffsetAt(c, l2) - seek;
            segs.push({ s0, s1, sp: (s1 - s0) / (l2 - l) });
          }
          const splitLabels = segs.map((_, i) => `${id}s${i}`);
          graph.push(`[${idx}:a]${ch.join(',')},asplit=${segs.length}${splitLabels.map((l) => `[${l}]`).join('')}`);
          segs.forEach((s, i) => {
            const tempo = atempoChain(Math.max(0.0625, s.sp));
            graph.push(
              `[${splitLabels[i]}]atrim=start=${f6(Math.max(0, s.s0))}:end=${f6(Math.max(s.s0 + 0.001, s.s1))},asetpts=PTS-STARTPTS${tempo.length ? ',' + tempo.join(',') : ''}[${id}t${i}]`,
            );
          });
          graph.push(`${segs.map((_, i) => `[${id}t${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[${id}r]`);
          ch.length = 0;
          ch.push('asetpts=PTS-STARTPTS');
          graph.push(`[${id}r]${buildAudioTail(p, c, track, a, b, la, R0, inp, ch)}[${id}]`);
        } else {
          const sp = c.speed || 1;
          ch.push(...atempoChain(sp));
          graph.push(`[${idx}:a]${buildAudioTail(p, c, track, a, b, la, R0, inp, ch)}[${id}]`);
        }
        mixIn.push(id);
      }
    }
    const tail: string[] = [];
    if (mixIn.length === 0) {
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f6(DUR)}[amix]`);
    } else {
      graph.push(
        `${mixIn.map((l) => `[${l}]`).join('')}amix=inputs=${mixIn.length}:normalize=0:dropout_transition=0:duration=longest,apad=whole_dur=${f6(DUR)},atrim=0:${f6(DUR)}[amix]`,
      );
    }
    if (inp.loudnorm) {
      const ln = inp.loudnorm;
      if (ln.mode === 'measure') tail.push(`loudnorm=I=${ln.target}:TP=-1:LRA=11:print_format=json`);
      else if (ln.measured) {
        const mm = ln.measured;
        tail.push(
          `loudnorm=I=${ln.target}:TP=-1:LRA=11:measured_I=${mm.input_i}:measured_TP=${mm.input_tp}:measured_LRA=${mm.input_lra}:measured_thresh=${mm.input_thresh}:offset=${mm.target_offset}:linear=true:print_format=summary`,
        );
      }
      tail.push('aresample=48000');
    }
    tail.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
    graph.push(`[amix]${tail.join(',')}[aout]`);
    audioLabel = 'aout';
  }

  const args: string[] = [];
  for (const i of inputs) args.push(...i.args);
  return {
    args,
    filterScript: graph.join(';\n') + '\n',
    files,
    videoLabel,
    audioLabel,
    duration: DUR,
    warnings,
  };
}

function buildAudioTail(
  p: Project,
  c: Clip,
  track: Track,
  a: number,
  b: number,
  la: number,
  R0: number,
  inp: BuildInput,
  ch: string[],
): string {
  const len = b - a;
  ch.push(`atrim=0:${f6(len)}`, 'asetpts=PTS-STARTPTS');
  // volume envelope sampled at 50 Hz (clip volume, keyframes, fades, track volume, ducking)
  const pts: Pt[] = [];
  const duck = track.role === 'music' && p.settings.duckingEnabled ? inp.duckGainAt : undefined;
  for (let t = 0; t <= len + 1e-6; t += 0.02) {
    let g = clipGainAt(p, c, la + t);
    if (duck) g *= duck(a + t);
    pts.push({ t, v: g });
  }
  if (isConstant(pts, 0.001)) {
    if (Math.abs(pts[0].v - 1) > 0.001) ch.push(`volume=${fmt(pts[0].v, 4)}`);
  } else {
    ch.push(`volume='${pwlExpr(simplify(pts, 0.002))}':eval=frame`);
  }
  const delayMs = Math.max(0, Math.round((a - R0) * 1000));
  if (delayMs > 0) ch.push(`adelay=delays=${delayMs}:all=1`);
  return ch.join(',');
}

export { contentSize };
