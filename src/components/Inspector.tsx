import React, { useEffect, useRef } from 'react';
import { Tip } from './Hints';
import { FontPicker } from './FontPicker';
import { Icon } from './Icon';
import { beginTx, commit, endTx, getState, setUI, toast, updateTx, useStore } from '../store/store';
import type { AnimProp, Clip, ColorSettings, Ease, LookId, Project, TextAnimation, TextProps, TransitionType } from '../../shared/types';
import { evalProp, isAnimated, keyNear, removeKeyNear, setKey, sortKeys, constProp, evalKeys, sourceSpan } from '../../shared/keyframes';
import { Field, Slider } from './common';
import { clamp, dbToGain, gainToDb, snapFrame } from '../../shared/time';
import { maxDuration, withLinked, trackOf, clearRange, quantizeProject } from '../../shared/timelineOps';
import { detectBeatsFor, extractAudio, freezeFrame, reverseClip, setTransition, loadProjectFonts } from '../store/actions';
import { addShake, punchIn } from './timeline/Timeline';
import { openRemoveBackground } from './logo/LogoMaker';
import { TEXT_PRESETS } from '../presets/textPresets';
import { ASPECTS } from '../../shared/defaults';
import { applyAspect } from '../presets/templates';
import { parseCube } from '../../shared/color';
import { TRANSITIONS as ALL_TRANSITIONS, TRANSITION_CATEGORIES, transitionInfo } from '../../shared/transitions';

// ------------------------------------------------------------------ editing helpers

/** Edits that coalesce a slider drag into one undo step. */
function useEditor(ids: string[]) {
  const active = useRef(false);
  const apply = (fn: (c: Clip, p: Project) => void) => {
    const run = (p: Project) => {
      for (const id of ids) if (p.clips[id]) fn(p.clips[id], p);
    };
    if (active.current) updateTx(run);
    else commit(run);
  };
  /** Like apply, but the callback gets the selected ids and the whole project. */
  const applyAll = (fn: (p: Project, ids: string[]) => void) => {
    const run = (p: Project) => fn(p, ids);
    if (active.current) updateTx(run);
    else commit(run);
  };
  return {
    applyAll,
    start: () => {
      if (!active.current) {
        beginTx();
        active.current = true;
      }
    },
    end: () => {
      if (active.current) {
        active.current = false;
        endTx(true);
      }
    },
    apply,
  };
}

function localTime(c: Clip): number {
  const s = getState();
  return clamp(snapFrame(s.ui.playhead - c.start, s.project.settings.fps), 0, c.duration);
}

function useLocal(c: Clip): number {
  const ph = useStore((s) => s.ui.playhead);
  const fps = useStore((s) => s.project.settings.fps);
  return clamp(snapFrame(ph - c.start, fps), 0, c.duration);
}

type PropPath = 'x' | 'y' | 'scale' | 'rotation' | 'opacity';

function AnimRow(props: {
  label: string;
  clip: Clip;
  ed: ReturnType<typeof useEditor>;
  get: (c: Clip) => AnimProp;
  set: (c: Clip, p: AnimProp) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  defaultValue: number;
}): React.ReactElement {
  const { clip, ed } = props;
  const local = useLocal(clip);
  const prop = props.get(clip);
  const value = evalProp(prop, local);
  const animated = isAnimated(prop) || (prop.keys?.length ?? 0) > 0;
  const onKey = !!keyNear(prop, local, 0.5 / getState().project.settings.fps);
  const change = (v: number) =>
    ed.apply((c) => {
      const p = props.get(c);
      const t = localTime(c);
      if (p.keys && p.keys.length > 0) props.set(c, setKey(p, t, v));
      else props.set(c, { value: v });
    });
  return (
    <Field
      label={props.label}
      extra={
        <span style={{ display: 'flex', gap: 3 }}>
          <button
            className={'kf-btn' + (onKey ? ' on' : animated ? ' has' : '')}
            title={onKey ? 'Remove keyframe here' : 'Add keyframe at playhead'}
            onClick={() =>
              ed.apply((c) => {
                const p = props.get(c);
                const t = localTime(c);
                if (onKey) props.set(c, removeKeyNear(p, t, 0.5 / getState().project.settings.fps));
                else {
                  let np = p;
                  if (!p.keys || p.keys.length === 0) np = setKey(p, 0, evalProp(p, t), 'easeInOut');
                  props.set(c, setKey(np, t, evalProp(p, t)));
                }
              })
            }
          >
            <Icon name="keyframe" size={12} />
          </button>
          <button
            className="kf-btn"
            title="Reset (removes keyframes)"
            onClick={() => ed.apply((c) => props.set(c, constProp(props.defaultValue)))}
          >
            <Icon name="reset" size={12} />
          </button>
        </span>
      }
    >
      <Slider value={value} min={props.min} max={props.max} step={props.step} format={props.format} onStart={ed.start} onCommit={ed.end} onChange={change} />
    </Field>
  );
}

function KeyNav({ clip, props }: { clip: Clip; props: AnimProp[] }): React.ReactElement | null {
  const local = useLocal(clip);
  const times = Array.from(new Set(props.flatMap((p) => (p.keys ?? []).map((k) => +k.t.toFixed(4))))).sort((a, b) => a - b);
  if (!times.length) return null;
  const prev = [...times].reverse().find((t) => t < local - 1e-3);
  const next = times.find((t) => t > local + 1e-3);
  const go = (t?: number) => t !== undefined && setUI({ playhead: clip.start + t });
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 8px' }}>
      <button className="small" disabled={prev === undefined} onClick={() => go(prev)}>
        <Icon name="chevronLeft" size={13} /> Prev key
      </button>
      <button className="small" disabled={next === undefined} onClick={() => go(next)}>
        Next key <Icon name="chevronRight" size={13} />
      </button>
      <span className="hint">{times.length} keyframe time{times.length > 1 ? 's' : ''}</span>
    </div>
  );
}

// ------------------------------------------------------------------ panels

function TransformPanel({ clip, ed }: { clip: Clip; ed: ReturnType<typeof useEditor> }): React.ReactElement {
  const p = useStore((s) => s.project);
  const W = p.settings.width;
  const H = p.settings.height;
  const tr = (k: PropPath) => ({
    get: (c: Clip) => c.transform[k],
    set: (c: Clip, v: AnimProp) => {
      c.transform = { ...c.transform, [k]: v };
    },
  });
  const media = clip.mediaId ? p.media[clip.mediaId] : undefined;
  const aspectDiffers = media && media.width / media.height > W / H + 0.05;
  return (
    <>
      <div className="section">
        <h4>
          Transform <span className="grow" />
          <button className="small" onClick={() => punchIn(clip.id)} title="Quick zoom on the beat at the playhead">
            <Icon name="bolt" size={13} /> Punch-in
          </button>
        </h4>
        <KeyNav clip={clip} props={Object.values(clip.transform)} />
        <AnimRow label="Position X" clip={clip} ed={ed} {...tr('x')} min={-W} max={W} step={1} defaultValue={0} format={(v) => v.toFixed(0)} />
        <AnimRow label="Position Y" clip={clip} ed={ed} {...tr('y')} min={-H} max={H} step={1} defaultValue={0} format={(v) => v.toFixed(0)} />
        <AnimRow label="Scale" clip={clip} ed={ed} {...tr('scale')} min={0.05} max={4} step={0.01} defaultValue={1} format={(v) => `${Math.round(v * 100)}%`} />
        <AnimRow label="Rotation" clip={clip} ed={ed} {...tr('rotation')} min={-180} max={180} step={0.5} defaultValue={0} format={(v) => `${v.toFixed(1)}°`} />
        <AnimRow label="Opacity" clip={clip} ed={ed} {...tr('opacity')} min={0} max={1} step={0.01} defaultValue={1} format={(v) => `${Math.round(v * 100)}%`} />
        {clip.kind !== 'text' && clip.kind !== 'adjust' && (
          <Field label="Fit">
            <select value={clip.fit} onChange={(e) => ed.apply((c) => (c.fit = e.target.value as Clip['fit']))}>
              <option value="fill">Fill (crop)</option>
              <option value="fit">Fit (bars)</option>
              <option value="stretch">Stretch</option>
            </select>
          </Field>
        )}
        <KeyEaseRow clip={clip} ed={ed} />
      </div>
      {clip.kind === 'video' && (
        <div className="section">
          <h4>Auto-reframe</h4>
          <Field label="Enabled">
            <input
              type="checkbox"
              checked={!!clip.reframe?.enabled}
              onChange={(e) =>
                ed.apply((c) => {
                  c.reframe = { enabled: e.target.checked, focusX: c.reframe?.focusX ?? constProp(0.5), focusY: c.reframe?.focusY ?? constProp(0.5) };
                  if (e.target.checked) c.fit = 'fill';
                })
              }
            />
            <span className="hint">{aspectDiffers ? 'Keeps the focus point in frame (16:9 → 9:16).' : 'Useful when the project is vertical or square.'}</span>
          </Field>
          {clip.reframe?.enabled && (
            <>
              <AnimRow
                label="Focus X"
                clip={clip}
                ed={ed}
                get={(c) => c.reframe?.focusX ?? constProp(0.5)}
                set={(c, v) => (c.reframe = { ...c.reframe!, focusX: v })}
                min={0}
                max={1}
                step={0.005}
                defaultValue={0.5}
                format={(v) => `${Math.round(v * 100)}%`}
              />
              <AnimRow
                label="Focus Y"
                clip={clip}
                ed={ed}
                get={(c) => c.reframe?.focusY ?? constProp(0.5)}
                set={(c, v) => (c.reframe = { ...c.reframe!, focusY: v })}
                min={0}
                max={1}
                step={0.005}
                defaultValue={0.5}
                format={(v) => `${Math.round(v * 100)}%`}
              />
              <div className="hint">Add keyframes on Focus X to follow the action across the shot.</div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function KeyEaseRow({ clip, ed }: { clip: Clip; ed: ReturnType<typeof useEditor> }): React.ReactElement | null {
  const local = useLocal(clip);
  const fps = useStore((s) => s.project.settings.fps);
  const keys = (['x', 'y', 'scale', 'rotation', 'opacity'] as PropPath[]).flatMap((k) => (clip.transform[k].keys ?? []).filter((kk) => Math.abs(kk.t - local) < 0.5 / fps));
  if (!keys.length) return null;
  return (
    <Field label="Key easing" title="Easing of the motion that starts at this keyframe">
      <select
        value={keys[0].ease}
        onChange={(e) =>
          ed.apply((c) => {
            const t = localTime(c);
            for (const k of ['x', 'y', 'scale', 'rotation', 'opacity'] as PropPath[]) {
              const p = c.transform[k];
              if (!p.keys) continue;
              c.transform[k] = { ...p, keys: p.keys.map((kk) => (Math.abs(kk.t - t) < 0.5 / fps ? { ...kk, ease: e.target.value as Ease } : kk)) };
            }
          })
        }
      >
        <option value="linear">Linear</option>
        <option value="easeIn">Ease in</option>
        <option value="easeOut">Ease out</option>
        <option value="easeInOut">Ease in/out</option>
        <option value="hold">Hold</option>
      </select>
    </Field>
  );
}

function SpeedPanel({ clip, ed }: { clip: Clip; ed: ReturnType<typeof useEditor> }): React.ReactElement {
  const p = useStore((s) => s.project);
  const local = useLocal(clip);
  const ramp = clip.speedKeys && clip.speedKeys.length >= 2;
  const setConst = (v: number) =>
    ed.applyAll((proj, ids) => {
      // linked video/audio change speed together so they stay in sync
      const all = withLinked(proj, ids).filter((id) => proj.clips[id] && proj.clips[id].kind !== 'text' && !trackOf(proj, proj.clips[id].trackId)?.locked);
      const changed = new Set(all);
      for (const id of all) {
        const c = proj.clips[id];
        const oldSpan = sourceSpan(c); // correct for ramps too
        c.speed = v;
        c.speedKeys = undefined;
        // keep the same source content: duration changes with speed
        const d = oldSpan / v;
        c.duration = snapFrame(Math.max(1 / proj.settings.fps, Math.min(d, maxDuration(proj, { ...c, duration: d }))), proj.settings.fps);
      }
      // a slower (longer) clip overwrites what follows instead of overlapping it
      for (const id of all) {
        const c = proj.clips[id];
        clearRange(proj, c.trackId, c.start, c.start + c.duration, changed);
      }
    });
  const presetRamp = (kind: 'slowmo' | 'rampIn' | 'rampOut' | 'impact') =>
    ed.apply((c) => {
      const d = c.duration;
      const k = (t: number, v: number, e: Ease = 'easeInOut') => ({ t: clamp(t, 0, d), v, ease: e });
      const at = localTime(c);
      if (kind === 'slowmo') c.speedKeys = [k(0, 1), k(at - 0.15, 1), k(at + 0.1, 0.25), k(at + 0.9, 0.25), k(at + 1.2, 1), k(d, 1)].filter((x, i, a) => i === 0 || x.t > a[i - 1].t);
      if (kind === 'rampIn') c.speedKeys = [k(0, 0.3), k(d * 0.6, 0.3), k(d, 2.5)];
      if (kind === 'rampOut') c.speedKeys = [k(0, 2.5), k(d * 0.4, 0.3), k(d, 0.3)];
      if (kind === 'impact') c.speedKeys = [k(0, 2), k(Math.max(0, at - 0.05), 2), k(at + 0.05, 0.2), k(at + 0.8, 0.2), k(Math.min(d, at + 1.0), 1.5), k(d, 1.5)].filter((x, i, a) => i === 0 || x.t > a[i - 1].t);
      c.speedKeys = sortKeys(c.speedKeys!);
    });
  const usedSrc = (c: Clip) => (c.speedKeys && c.speedKeys.length >= 2 ? '' : '');
  void usedSrc;
  return (
    <div className="section">
      <h4>Speed</h4>
      <Field label="Constant">
        <Slider value={ramp ? 1 : clip.speed} min={0.25} max={8} step={0.05} format={(v) => `${v.toFixed(2)}×`} onStart={ed.start} onCommit={ed.end} onChange={setConst} />
      </Field>
      <div className="chips" style={{ marginBottom: 10 }}>
        {[0.25, 0.5, 1, 1.5, 2, 4, 8].map((v) => (
          <button key={v} className={!ramp && Math.abs(clip.speed - v) < 1e-3 ? 'on' : ''} onClick={() => setConst(v)}>
            {v}×
          </button>
        ))}
      </div>
      <h4>
        Speed ramp <span className="grow" />
        {ramp && (
          <button className="small" onClick={() => ed.apply((c) => (c.speedKeys = undefined))}>
            Remove
          </button>
        )}
      </h4>
      <div className="chips" style={{ marginBottom: 8 }}>
        <button onClick={() => presetRamp('slowmo')} title="Smooth slow-mo around the playhead">
          Slow-mo at playhead
        </button>
        <button onClick={() => presetRamp('impact')} title="Fast → slow at the playhead → fast">
          Impact ramp
        </button>
        <button onClick={() => presetRamp('rampIn')}>Slow → fast</button>
        <button onClick={() => presetRamp('rampOut')}>Fast → slow</button>
      </div>
      {ramp && (
        <>
          <RampGraph clip={clip} local={local} />
          <AnimRow
            label="Speed here"
            clip={clip}
            ed={ed}
            get={(c) => ({ value: 1, keys: c.speedKeys })}
            set={(c, v) => (c.speedKeys = v.keys && v.keys.length ? v.keys : undefined)}
            min={0.1}
            max={8}
            step={0.05}
            defaultValue={1}
            format={(v) => `${v.toFixed(2)}×`}
          />
          <div className="hint">Ramps change how much source footage is used; trim the clip end if it runs past the source.</div>
        </>
      )}
      <div className="hint" style={{ marginTop: 6 }}>
        Clip uses {(clip.in).toFixed(2)}s → source; timeline length {clip.duration.toFixed(2)}s.
        {p.media[clip.mediaId ?? '']?.hasAudio ? ' Audio is time-stretched with the speed.' : ''}
      </div>
    </div>
  );
}

function RampGraph({ clip, local }: { clip: Clip; local: number }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !clip.speedKeys) return;
    const w = cv.width;
    const h = cv.height;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1015';
    ctx.fillRect(0, 0, w, h);
    const y = (v: number) => h - 6 - (Math.log2(clamp(v, 0.1, 4)) + 3.32) / 5.32 * (h - 12);
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(0, y(1));
    ctx.lineTo(w, y(1));
    ctx.stroke();
    ctx.strokeStyle = '#ffd25e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const v = evalKeys(clip.speedKeys, (x / w) * clip.duration);
      if (x === 0) ctx.moveTo(x, y(v));
      else ctx.lineTo(x, y(v));
    }
    ctx.stroke();
    ctx.fillStyle = '#ffd25e';
    for (const k of clip.speedKeys) {
      ctx.fillRect((k.t / clip.duration) * w - 3, y(k.v) - 3, 6, 6);
    }
    ctx.fillStyle = '#ff3b4d';
    ctx.fillRect((local / clip.duration) * w, 0, 1, h);
  });
  return <canvas ref={ref} width={290} height={70} style={{ width: '100%', borderRadius: 4, marginBottom: 6 }} />;
}

const LOOKS: { id: LookId; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'horror', label: 'Horror' },
  { id: 'vibrant', label: 'Vibrant Fortnite' },
];

function ColorPanel({ clip, ed }: { clip: Clip; ed: ReturnType<typeof useEditor> }): React.ReactElement {
  const c = clip.color;
  const set = (k: keyof ColorSettings) => (v: number) => ed.apply((cc) => (cc.color = { ...cc.color, [k]: v }));
  const row = (label: string, k: keyof ColorSettings, min: number, max: number) => (
    <Field label={label} extra={<button className="kf-btn" title="Reset" onClick={() => ed.apply((cc) => (cc.color = { ...cc.color, [k]: 0 }))}><Icon name="reset" size={12} /></button>}>
      <Slider value={c[k] as number} min={min} max={max} step={0.01} onStart={ed.start} onCommit={ed.end} onChange={set(k)} format={(v) => (v * 100).toFixed(0)} />
    </Field>
  );
  const importLut = async () => {
    const r = await window.api.openFiles({ title: 'Import .cube LUT', filters: [{ name: '3D LUT', extensions: ['cube'] }] });
    if (!r.length) return;
    try {
      parseCube(await window.api.readText(r[0]));
      ed.apply((cc) => (cc.color = { ...cc.color, lutPath: r[0], lutIntensity: 1 }));
      toast('LUT applied', 'success', 1500);
    } catch (e) {
      toast(`Could not load LUT: ${(e as Error).message}`, 'error');
    }
  };
  return (
    <>
      <div className="section">
        <h4>Looks</h4>
        <div className="chips" style={{ marginBottom: 8 }}>
          {LOOKS.map((l) => (
            <button key={l.id} className={c.look === l.id ? 'on' : ''} onClick={() => ed.apply((cc) => (cc.color = { ...cc.color, look: l.id }))}>
              {l.label}
            </button>
          ))}
        </div>
        {c.look !== 'none' && (
          <Field label="Look amount">
            <Slider value={c.lookIntensity} min={0} max={1} step={0.01} onStart={ed.start} onCommit={ed.end} onChange={set('lookIntensity')} format={(v) => `${Math.round(v * 100)}%`} />
          </Field>
        )}
      </div>
      <div className="section">
        <h4>
          Adjust <span className="grow" />
          <button className="small" onClick={() => ed.apply((cc) => (cc.color = { ...cc.color, brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, vignette: 0 }))}>
            Reset
          </button>
        </h4>
        {row('Brightness', 'brightness', -1, 1)}
        {row('Contrast', 'contrast', -1, 1)}
        {row('Saturation', 'saturation', -1, 1)}
        {row('Temperature', 'temperature', -1, 1)}
        {row('Tint', 'tint', -1, 1)}
        <Field label="Vignette">
          <Slider value={c.vignette} min={0} max={1} step={0.01} onStart={ed.start} onCommit={ed.end} onChange={set('vignette')} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
      </div>
      <div className="section">
        <h4>LUT (.cube)</h4>
        <Field label="File">
          <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.lutPath}>
            {c.lutPath ? c.lutPath.split(/[\\/]/).pop() : 'none'}
          </span>
          <button className="small" onClick={importLut}>
            Import…
          </button>
          {c.lutPath && (
            <button className="small ghost icon" onClick={() => ed.apply((cc) => (cc.color = { ...cc.color, lutPath: undefined }))}>
              <Icon name="close" size={12} />
            </button>
          )}
        </Field>
        {c.lutPath && (
          <Field label="LUT amount">
            <Slider value={c.lutIntensity} min={0} max={1} step={0.01} onStart={ed.start} onCommit={ed.end} onChange={set('lutIntensity')} format={(v) => `${Math.round(v * 100)}%`} />
          </Field>
        )}
        <button className="small" onClick={() => copyColorToSelection(clip)} style={{ marginTop: 4 }}>
          Copy grade to all clips on this track
        </button>
      </div>
    </>
  );
}

function copyColorToSelection(clip: Clip): void {
  commit((p) => {
    for (const c of Object.values(p.clips)) if (c.trackId === clip.trackId && c.kind !== 'audio') c.color = structuredClone(clip.color);
  });
  toast('Grade copied to the track', 'success', 1500);
}

function applyTransitionToTrack(clip: Clip): void {
  const tr = clip.transitionIn;
  if (!tr) return;
  commit((p) => {
    const fps = p.settings.fps;
    for (const c of Object.values(p.clips)) {
      if (c.trackId !== clip.trackId || c.id === clip.id) continue;
      // only real cuts: a clip that starts where another one ends
      const prev = Object.values(p.clips).some((o) => o.trackId === c.trackId && o.id !== c.id && Math.abs(o.start + o.duration - c.start) <= 0.5 / fps);
      if (prev) c.transitionIn = { ...tr, duration: Math.min(tr.duration, c.duration / 2) };
    }
  });
  toast('Transition applied to every cut on this track', 'success', 1800);
}

/** Tiny white line glyph that hints at what a transition does. */
function TransGlyph({ id }: { id: TransitionType | null }): React.ReactElement {
  const info = id ? transitionInfo(id) : undefined;
  const cat = info?.category;
  const box = <rect x="2.5" y="4.5" width="19" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />;
  let inner: React.ReactNode = <line x1="12" y1="4.5" x2="12" y2="19.5" stroke="currentColor" strokeWidth="1.4" />;
  if (id && cat === 'Fade') inner = <rect x="2.5" y="4.5" width="19" height="15" rx="2" fill="url(#tg-fade)" stroke="none" />;
  if (id && (cat === 'Slide & push' || cat === 'Motion')) {
    const dir = /Right/.test(id) ? -1 : /Up/.test(id) ? 2 : /Down/.test(id) ? -2 : 1;
    inner =
      Math.abs(dir) === 1 ? (
        <path d={dir > 0 ? 'M16 12H7m3-3-3 3 3 3' : 'M8 12h9m-3-3 3 3-3 3'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d={dir > 0 ? 'M12 16V8m-3 3 3-3 3 3' : 'M12 8v8m-3-3 3 3 3-3'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      );
    if (id === 'shakeCut') inner = <path d="M6 14l3-4 3 5 3-6 3 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />;
  }
  if (id && cat === 'Wipe') inner = id === 'blinds' ? <path d="M3 8h18M3 12h18M3 16h18" stroke="currentColor" strokeWidth="1.4" /> : id === 'barsVertical' ? <path d="M7 5v14M12 5v14M17 5v14" stroke="currentColor" strokeWidth="1.4" /> : <path d={id === 'wipeDiagonal' ? 'M3 19 21 5' : id === 'wipeUp' || id === 'wipeDown' ? 'M3 12h18' : 'M12 5v14'} stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6" />;
  if (id === 'iris') inner = <circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />;
  if (id === 'diamond') inner = <path d="M12 7l5 5-5 5-5-5z" fill="none" stroke="currentColor" strokeWidth="1.4" />;
  if (id === 'clockWipe') inner = <path d="M12 12V6.5M12 12l4 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />;
  if (id && cat === 'Zoom & spin') inner = id === 'spin' ? <path d="M16.5 9.5A5 5 0 1 0 17 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /> : <><rect x="8" y="9" width="8" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5 6.5l3 2.5M19 6.5l-3 2.5M5 17.5l3-2.5M19 17.5l-3-2.5" stroke="currentColor" strokeWidth="1.2" /></>;
  if (id && cat === 'Stylized') inner = <path d="M5 9h6M13 9h6M7 12h10M4 15h7M14 15h5" stroke="currentColor" strokeWidth="1.4" />;
  return (
    <svg width="34" height="24" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="tg-fade" x1="0" x2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.05" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.7" />
        </linearGradient>
      </defs>
      {box}
      {inner}
    </svg>
  );
}

function EffectsPanel({ clip, ed }: { clip: Clip; ed: ReturnType<typeof useEditor> }): React.ReactElement {
  return (
    <>
      <div className="section">
        <h4>
          Transition in <span className="grow" />
          {clip.transitionIn && (
            <button className="small" title="Use this transition on every cut of this track" onClick={() => applyTransitionToTrack(clip)}>
              All cuts
            </button>
          )}
        </h4>
        <div className="trans-grid">
          <button className={'trans-tile' + (!clip.transitionIn ? ' on' : '')} onClick={() => setTransition(clip.id, null)} title="Hard cut, no transition">
            <TransGlyph id={null} />
            <span>Cut</span>
          </button>
        </div>
        {TRANSITION_CATEGORIES.map((cat) => (
          <div key={cat}>
            <div className="trans-cat">{cat}</div>
            <div className="trans-grid">
              {ALL_TRANSITIONS.filter((t) => t.category === cat).map((t) => (
                <button
                  key={t.id}
                  className={'trans-tile' + (clip.transitionIn?.type === t.id ? ' on' : '')}
                  title={t.hint}
                  onClick={() => setTransition(clip.id, t.id, clip.transitionIn && clip.transitionIn.type === t.id ? clip.transitionIn.duration : t.duration)}
                >
                  <TransGlyph id={t.id} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {clip.transitionIn && (
          <Field label="Duration">
            <Slider
              value={clip.transitionIn.duration}
              min={0.1}
              max={3}
              step={0.05}
              format={(v) => `${v.toFixed(2)}s`}
              onStart={ed.start}
              onCommit={ed.end}
              onChange={(v) => ed.apply((c) => c.transitionIn && (c.transitionIn = { ...c.transitionIn, duration: v }))}
            />
          </Field>
        )}
        <div className="hint">The transition plays across the cut with the previous clip on this track (or from black if there is none). Hover a tile to see what it does.</div>
      </div>
      <div className="section">
        <h4>Fade picture</h4>
        <Field label="Fade in">
          <Slider value={clip.videoFadeIn ?? 0} min={0} max={Math.min(5, clip.duration / 2)} step={0.05} format={(v) => (v > 0 ? `${v.toFixed(2)}s` : 'off')} onStart={ed.start} onCommit={ed.end} onChange={(v) => ed.apply((c) => (c.videoFadeIn = v))} />
        </Field>
        <Field label="Fade out">
          <Slider value={clip.videoFadeOut ?? 0} min={0} max={Math.min(5, clip.duration / 2)} step={0.05} format={(v) => (v > 0 ? `${v.toFixed(2)}s` : 'off')} onStart={ed.start} onCommit={ed.end} onChange={(v) => ed.apply((c) => (c.videoFadeOut = v))} />
        </Field>
        <Field label="Fade to">
          <div className="chips">
            {(['black', 'white', 'transparent'] as const).map((col) => (
              <button key={col} className={(clip.fadeColor ?? (clip.kind === 'video' ? 'black' : 'transparent')) === col ? 'on' : ''} onClick={() => ed.apply((c) => (c.fadeColor = col))}>
                {col === 'transparent' ? 'Clear' : col[0].toUpperCase() + col.slice(1)}
              </button>
            ))}
          </div>
        </Field>
        <div className="chips" style={{ marginTop: 4 }}>
          <button onClick={() => ed.apply((c) => ((c.videoFadeIn = Math.min(1, c.duration / 3)), (c.videoFadeOut = Math.min(1, c.duration / 3))))}>Fade in + out</button>
          <button onClick={() => ed.apply((c) => ((c.videoFadeIn = 0), (c.videoFadeOut = 0)))}>No fades</button>
        </div>
        <div className="hint">Fades the picture from/to black, white or transparent (Clear shows the tracks below). Use Audio → Fade for the sound.</div>
      </div>
      {clip.kind !== 'text' && clip.kind !== 'adjust' && (
        <div className="section">
          <h4>Blur</h4>
          <Field label="Amount">
            <Slider value={clip.blur ?? 0} min={0} max={40} step={0.5} format={(v) => (v > 0 ? v.toFixed(1) : 'off')} onStart={ed.start} onCommit={ed.end} onChange={(v) => ed.apply((c) => (c.blur = v || undefined))} />
          </Field>
          <div className="hint">Great for end screens: blur the background so your logo and island code pop. Zoom in a little (Transform → Scale 110%) to hide soft edges.</div>
        </div>
      )}
      {clip.kind !== 'text' && clip.kind !== 'adjust' && (
        <div className="section">
          <h4>
            Camera shake <span className="grow" />
            <button className="small" onClick={() => addShake(clip.id)}>
              + At playhead
            </button>
          </h4>
          {clip.shakes.length === 0 && <div className="hint">Great for hits and explosions. Adds a decaying shake starting at the playhead.</div>}
          {clip.shakes.map((s, i) => (
            <div key={i} style={{ borderTop: i ? '1px solid var(--line)' : undefined, paddingTop: i ? 6 : 0 }}>
              <Field label={`Shake ${i + 1}`} extra={<button className="kf-btn" title="Remove" onClick={() => ed.apply((c) => (c.shakes = c.shakes.filter((_, j) => j !== i)))}><Icon name="close" size={12} /></button>}>
                <span className="hint">at {s.at.toFixed(2)}s</span>
                <button className="small" onClick={() => setUI({ playhead: clip.start + s.at })}>
                  Go
                </button>
              </Field>
              <Field label="Intensity">
                <Slider value={s.intensity} min={0.05} max={1} step={0.01} onStart={ed.start} onCommit={ed.end} onChange={(v) => ed.apply((c) => (c.shakes = c.shakes.map((x, j) => (j === i ? { ...x, intensity: v } : x))))} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
              <Field label="Duration">
                <Slider value={s.duration} min={0.1} max={3} step={0.05} onStart={ed.start} onCommit={ed.end} onChange={(v) => ed.apply((c) => (c.shakes = c.shakes.map((x, j) => (j === i ? { ...x, duration: v } : x))))} format={(v) => `${v.toFixed(2)}s`} />
              </Field>
              <Field label="Frequency">
                <Slider value={s.frequency} min={2} max={20} step={0.5} onStart={ed.start} onCommit={ed.end} onChange={(v) => ed.apply((c) => (c.shakes = c.shakes.map((x, j) => (j === i ? { ...x, frequency: v } : x))))} format={(v) => `${v.toFixed(1)}`} />
              </Field>
            </div>
          ))}
        </div>
      )}
      {clip.kind === 'video' && (
        <div className="section">
          <h4>Clip tools</h4>
          <div className="chips">
            <button onClick={() => freezeFrame(clip.id)}><Icon name="snow" size={14} /> Freeze frame at playhead</button>
            <button onClick={() => reverseClip(clip.id)}><Icon name="reverse" size={14} /> {clip.reversed ? 'Un-reverse' : 'Reverse'}</button>
          </div>
        </div>
      )}
      {clip.kind === 'adjust' && clip.adjust && (
        <div className="section">
          <h4>Letterbox</h4>
          <Field label="Enabled">
            <input type="checkbox" checked={clip.adjust.letterbox} onChange={(e) => ed.apply((c) => (c.adjust = { ...c.adjust!, letterbox: e.target.checked }))} />
          </Field>
          <Field label="Ratio">
            <select value={clip.adjust.letterboxRatio} onChange={(e) => ed.apply((c) => (c.adjust = { ...c.adjust!, letterboxRatio: Number(e.target.value) }))}>
              <option value={2.39}>2.39:1 (scope)</option>
              <option value={2.0}>2.00:1</option>
              <option value={1.85}>1.85:1</option>
            </select>
          </Field>
          <div className="hint">Bars cover everything on tracks below this one. Stretch the clip over your cinematic section.</div>
        </div>
      )}
    </>
  );
}

function AudioPanel({ clip, ed }: { clip: Clip; ed: ReturnType<typeof useEditor> }): React.ReactElement {
  const p = useStore((s) => s.project);
  const m = clip.mediaId ? p.media[clip.mediaId] : undefined;
  const db = gainToDb(clip.volume);
  const local = useLocal(clip);
  const keys = clip.volumeKeys && clip.volumeKeys.length >= 2;
  return (
    <div className="section">
      <h4>Audio</h4>
      {clip.kind === 'video' && clip.audioDetached && <div className="hint" style={{ marginBottom: 8 }}>This clip's audio was extracted to an audio track. Select that clip to edit it.</div>}
      {clip.kind === 'video' && !m?.hasAudio && <div className="hint">This video has no audio.</div>}
      {(clip.kind === 'audio' || (m?.hasAudio && !clip.audioDetached)) && (
        <>
          <Field label="Volume" extra={<button className="kf-btn" title="Reset to 0 dB" onClick={() => ed.apply((c) => (c.volume = 1))}><Icon name="reset" size={12} /></button>}>
            <Slider
              value={isFinite(db) ? clamp(db, -40, 12) : -40}
              min={-40}
              max={12}
              step={0.5}
              format={(v) => (v <= -40 ? '-∞' : `${v.toFixed(1)} dB`)}
              onStart={ed.start}
              onCommit={ed.end}
              onChange={(v) => ed.apply((c) => (c.volume = v <= -40 ? 0 : dbToGain(v)))}
            />
          </Field>
          <Field label="Mute">
            <input type="checkbox" checked={clip.muted} onChange={(e) => ed.apply((c) => (c.muted = e.target.checked))} />
          </Field>
          {clip.kind === 'audio' && (
            <>
              <Field label="Fade in">
                <Slider value={clip.fadeIn} min={0} max={Math.min(10, clip.duration / 2)} step={0.05} format={(v) => `${v.toFixed(2)}s`} onStart={ed.start} onCommit={ed.end} onChange={(v) => ed.apply((c) => (c.fadeIn = v))} />
              </Field>
              <Field label="Fade out">
                <Slider value={clip.fadeOut} min={0} max={Math.min(10, clip.duration / 2)} step={0.05} format={(v) => `${v.toFixed(2)}s`} onStart={ed.start} onCommit={ed.end} onChange={(v) => ed.apply((c) => (c.fadeOut = v))} />
              </Field>
              <h4 style={{ marginTop: 10 }}>
                Volume keyframes <span className="grow" />
                {keys && (
                  <button className="small" onClick={() => ed.apply((c) => (c.volumeKeys = undefined))}>
                    Clear
                  </button>
                )}
              </h4>
              <div className="chips" style={{ marginBottom: 6 }}>
                <button
                  onClick={() =>
                    ed.apply((c) => {
                      const ks = c.volumeKeys && c.volumeKeys.length >= 2 ? [...c.volumeKeys] : [{ t: 0, v: 1, ease: 'linear' as Ease }, { t: c.duration, v: 1, ease: 'linear' as Ease }];
                      const t = localTime(c);
                      ks.push({ t, v: evalKeys(ks, t), ease: 'linear' });
                      c.volumeKeys = sortKeys(ks);
                    })
                  }
                >
                  <Icon name="keyframe" size={12} /> Add key at playhead
                </button>
                <button
                  title="Dip the volume around the playhead (e.g. under a voice line)"
                  onClick={() =>
                    ed.apply((c) => {
                      const t = localTime(c);
                      const ks = c.volumeKeys && c.volumeKeys.length >= 2 ? [...c.volumeKeys] : [{ t: 0, v: 1, ease: 'linear' as Ease }, { t: c.duration, v: 1, ease: 'linear' as Ease }];
                      const pts = [t - 0.4, t, t + 1.5, t + 1.9].map((x) => clamp(x, 0, c.duration));
                      ks.push({ t: pts[0], v: 1, ease: 'linear' }, { t: pts[1], v: 0.35, ease: 'linear' }, { t: pts[2], v: 0.35, ease: 'linear' }, { t: pts[3], v: 1, ease: 'linear' });
                      c.volumeKeys = sortKeys(ks);
                    })
                  }
                >
                  Dip here
                </button>
              </div>
              <div className="hint">
                On the timeline: drag the yellow line to change volume, <b>Alt+click</b> it to add a keyframe, drag keyframes to move them and double-click to delete. Drag the white dots in the corners for fades.
                {keys ? ` Gain here: ${gainToDb(evalKeys(clip.volumeKeys!, local)).toFixed(1)} dB.` : ''}
              </div>
            </>
          )}
          {clip.kind === 'video' && m?.hasAudio && !clip.audioDetached && (
            <button className="small" onClick={() => extractAudio(clip.id)} style={{ marginTop: 6 }}>
              Extract audio to its own track
            </button>
          )}
          {clip.kind === 'audio' && m?.hasAudio && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
              <button className="small" onClick={() => detectBeatsFor(clip.id)}>
                <Icon name="beat" size={13} /> {m.beats ? 'Re-detect beats' : 'Detect beats'}
              </button>
              {m.bpm ? <span className="hint">{m.bpm} BPM</span> : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const ANIMS: { id: TextAnimation; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fadeUp', label: 'Fade up' },
  { id: 'scalePunch', label: 'Scale punch' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'glitchIn', label: 'Glitch' },
  { id: 'slam', label: 'Slam' },
];

function TextPanel({ clip, ed }: { clip: Clip; ed: ReturnType<typeof useEditor> }): React.ReactElement | null {
  const customFonts = useStore((s) => s.project.fonts);
  const t = clip.text;
  if (!t) return null;
  const set = <K extends keyof TextProps>(k: K) => (v: TextProps[K]) => ed.apply((c) => c.text && (c.text = { ...c.text, [k]: v }));
  const loadFont = async () => {
    const r = await window.api.openFiles({ title: 'Load font', filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }] });
    if (!r.length) return;
    const family = r[0].split(/[\\/]/).pop()!.replace(/\.(ttf|otf)$/i, '');
    commit((p) => {
      if (!p.fonts.some((f) => f.family === family)) p.fonts.push({ family, path: r[0] });
    });
    await loadProjectFonts(getState().project);
    set('fontFamily')(family);
    toast(`Font "${family}" loaded`, 'success', 1500);
  };
  return (
    <>
      <div className="section">
        <h4>Text</h4>
        <textarea
          value={t.text}
          rows={3}
          style={{ width: '100%', resize: 'vertical', fontSize: 14 }}
          onChange={(e) => set('text')(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Field label="Sub line">
          <input type="text" value={t.subText ?? ''} onChange={(e) => set('subText')(e.target.value || undefined)} onKeyDown={(e) => e.stopPropagation()} placeholder="optional" />
        </Field>
        <Field label="Font">
          <FontPicker value={t.fontFamily} onChange={(f) => set('fontFamily')(f)} extra={customFonts.map((f) => f.family)} sample={t.text.split('\n')[0].slice(0, 22) || undefined} />
          <button className="small" onClick={loadFont} title="Load a .ttf / .otf file">
            +
          </button>
        </Field>
        <Field label="Weight">
          <select value={t.fontWeight} onChange={(e) => set('fontWeight')(Number(e.target.value))}>
            {[300, 400, 500, 600, 700, 800, 900].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={t.italic} onChange={(e) => set('italic')(e.target.checked)} /> Italic
          </label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={t.uppercase} onChange={(e) => set('uppercase')(e.target.checked)} /> CAPS
          </label>
        </Field>
        <Field label="Size">
          <Slider value={t.fontSize} min={12} max={400} step={1} format={(v) => v.toFixed(0)} onStart={ed.start} onCommit={ed.end} onChange={set('fontSize')} />
        </Field>
        <Field label="Color">
          <input type="color" value={t.color} onChange={(e) => set('color')(e.target.value)} />
          <span className="hint">Spacing</span>
          <Slider value={t.letterSpacing} min={-5} max={40} step={0.5} format={(v) => v.toFixed(1)} onStart={ed.start} onCommit={ed.end} onChange={set('letterSpacing')} width={44} />
        </Field>
        <Field label="Outline">
          <input type="color" value={t.outlineColor} onChange={(e) => set('outlineColor')(e.target.value)} />
          <Slider value={t.outlineWidth} min={0} max={20} step={0.5} format={(v) => v.toFixed(1)} onStart={ed.start} onCommit={ed.end} onChange={set('outlineWidth')} width={44} />
        </Field>
        <Field label="Shadow">
          <Slider value={t.shadowBlur} min={0} max={60} step={1} format={(v) => v.toFixed(0)} onStart={ed.start} onCommit={ed.end} onChange={set('shadowBlur')} width={44} />
        </Field>
        <Field label="Shadow offset">
          <Slider value={t.shadowOffset} min={0} max={30} step={1} format={(v) => v.toFixed(0)} onStart={ed.start} onCommit={ed.end} onChange={set('shadowOffset')} width={44} />
        </Field>
        <Field label="Align">
          <div className="seg">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button key={a} className={'small' + (t.align === a ? ' toggle on' : '')} onClick={() => set('align')(a)}>
                {a}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Position X">
          <Slider value={t.posX} min={0} max={1} step={0.005} format={(v) => `${Math.round(v * 100)}%`} onStart={ed.start} onCommit={ed.end} onChange={set('posX')} />
        </Field>
        <Field label="Position Y">
          <Slider value={t.posY} min={0} max={1} step={0.005} format={(v) => `${Math.round(v * 100)}%`} onStart={ed.start} onCommit={ed.end} onChange={set('posY')} />
        </Field>
        <Field label="Box">
          <input type="checkbox" checked={t.box} onChange={(e) => set('box')(e.target.checked)} />
          <input type="color" value={t.boxColor} onChange={(e) => set('boxColor')(e.target.value)} />
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={t.accentBar} onChange={(e) => set('accentBar')(e.target.checked)} /> Accent
          </label>
          <input type="color" value={t.accentColor} onChange={(e) => set('accentColor')(e.target.value)} />
        </Field>
      </div>
      <div className="section">
        <h4>Animation</h4>
        <Field label="In">
          <select value={t.animIn} onChange={(e) => set('animIn')(e.target.value as TextAnimation)}>
            {ANIMS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <Slider value={t.animInDuration} min={0.1} max={3} step={0.05} format={(v) => `${v.toFixed(2)}s`} onStart={ed.start} onCommit={ed.end} onChange={set('animInDuration')} width={48} />
        </Field>
        <Field label="Out">
          <select value={t.animOut} onChange={(e) => set('animOut')(e.target.value as TextAnimation)}>
            {ANIMS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <Slider value={t.animOutDuration} min={0.1} max={3} step={0.05} format={(v) => `${v.toFixed(2)}s`} onStart={ed.start} onCommit={ed.end} onChange={set('animOutDuration')} width={48} />
        </Field>
      </div>
      <div className="section">
        <h4>Presets</h4>
        <div className="chips">
          {TEXT_PRESETS.map((pr) => (
            <button key={pr.id} onClick={() => ed.apply((c) => pr.apply(c, getState().project))} title={pr.description}>
              {pr.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ project panel

function ProjectPanel(): React.ReactElement {
  const p = useStore((s) => s.project);
  const s = p.settings;
  const set = (fn: (pp: Project) => void) => commit(fn);
  const ed = useRef(false);
  const live = (fn: (pp: Project) => void) => {
    if (ed.current) updateTx(fn);
    else commit(fn);
  };
  const start = () => {
    if (!ed.current) {
      beginTx();
      ed.current = true;
    }
  };
  const end = () => {
    if (ed.current) {
      ed.current = false;
      endTx(true);
    }
  };
  return (
    <>
      <div className="section">
        <h4>Project</h4>
        <Field label="Name">
          <input type="text" value={p.name} onChange={(e) => set((pp) => void (pp.name = e.target.value))} onKeyDown={(e) => e.stopPropagation()} />
        </Field>
        <Field label="Aspect">
          <select value={s.aspect} onChange={(e) => applyAspect(e.target.value as Project['settings']['aspect'])}>
            {Object.entries(ASPECTS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Frame rate">
          <select value={s.fps} onChange={(e) => set((pp) => { pp.settings.fps = Number(e.target.value); quantizeProject(pp); })}>
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </Field>
        <Field label="Background">
          <input type="color" value={s.backgroundColor} onChange={(e) => set((pp) => void (pp.settings.backgroundColor = e.target.value))} />
        </Field>
      </div>
      <div className="section">
        <h4>Auto-ducking</h4>
        <Field label="Enabled">
          <input type="checkbox" checked={s.duckingEnabled} onChange={(e) => set((pp) => void (pp.settings.duckingEnabled = e.target.checked))} />
          <span className="hint">Music tracks get quieter while Voice/SFX tracks play.</span>
        </Field>
        <Field label="Amount">
          <Slider value={s.duckAmountDb} min={2} max={30} step={0.5} format={(v) => `-${v.toFixed(1)} dB`} onStart={start} onCommit={end} onChange={(v) => live((pp) => void (pp.settings.duckAmountDb = v))} />
        </Field>
        <Field label="Attack">
          <Slider value={s.duckAttack} min={0.02} max={1} step={0.01} format={(v) => `${v.toFixed(2)}s`} onStart={start} onCommit={end} onChange={(v) => live((pp) => void (pp.settings.duckAttack = v))} />
        </Field>
        <Field label="Release">
          <Slider value={s.duckRelease} min={0.05} max={2} step={0.01} format={(v) => `${v.toFixed(2)}s`} onStart={start} onCommit={end} onChange={(v) => live((pp) => void (pp.settings.duckRelease = v))} />
        </Field>
        <Field label="Sensitivity">
          <Slider value={s.duckThresholdDb} min={-60} max={-10} step={1} format={(v) => `${v.toFixed(0)} dB`} onStart={start} onCommit={end} onChange={(v) => live((pp) => void (pp.settings.duckThresholdDb = v))} />
        </Field>
        <div className="hint">Set track roles with the dropdown in each audio track header.</div>
      </div>
      <div className="section">
        <h4>Loudness</h4>
        <Field label="Normalize">
          <input type="checkbox" checked={s.normalizeLoudness} onChange={(e) => set((pp) => void (pp.settings.normalizeLoudness = e.target.checked))} />
          <span className="hint">on export</span>
        </Field>
        <Field label="Target">
          <select value={s.targetLufs} onChange={(e) => set((pp) => void (pp.settings.targetLufs = Number(e.target.value)))}>
            <option value={-14}>-14 LUFS (YouTube)</option>
            <option value={-16}>-16 LUFS</option>
            <option value={-11}>-11 LUFS (loud)</option>
          </select>
        </Field>
      </div>
      <div className="section">
        <div className="hint">Select a clip on the timeline to edit its transform, speed, color, effects, audio or text.</div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ inspector shell

export function Inspector(): React.ReactElement {
  const selection = useStore((s) => s.ui.selection);
  const clips = useStore((s) => s.project.clips);
  const media = useStore((s) => s.project.media);
  const tab = useStore((s) => s.ui.inspectorTab);
  const sel = selection.map((id) => clips[id]).filter(Boolean) as Clip[];
  // primary: prefer a visual clip
  const primary = sel.find((c) => c.kind !== 'audio') ?? sel[0];
  const ids = primary ? sel.filter((c) => c.kind === primary.kind).map((c) => c.id) : [];
  const ed = useEditor(ids);
  if (!primary) {
    return (
      <div className="panel" data-tour="inspector">
        <div className="panel-head">
          <Icon name="settings" /> Project settings
        </div>
        <div className="panel-body">
          <Tip id="insp-empty">Click any clip on the timeline to edit it here: size, speed and slow-mo, color, transitions, volume and text.</Tip>
          <ProjectPanel />
        </div>
      </div>
    );
  }
  const tabs: { id: string; label: string }[] = [];
  if (primary.kind === 'text') tabs.push({ id: 'text', label: 'Text' });
  if (primary.kind !== 'audio') tabs.push({ id: 'video', label: 'Transform' });
  if (primary.kind === 'video' || primary.kind === 'audio') tabs.push({ id: 'speed', label: 'Speed' });
  if (primary.kind === 'video' || primary.kind === 'image') tabs.push({ id: 'color', label: 'Color' });
  if (primary.kind !== 'audio') tabs.push({ id: 'effects', label: 'Effects' });
  if (primary.kind === 'video' || primary.kind === 'audio') tabs.push({ id: 'audio', label: 'Audio' });
  const active = tabs.find((t) => t.id === tab)?.id ?? tabs[0].id;
  const audioClip = sel.find((c) => c.kind === 'audio');
  return (
    <div className="panel" data-tour="inspector">
      <div className="panel-head">
        <Icon name={primary.kind === 'audio' ? 'audio' : primary.kind === 'text' ? 'text' : primary.kind === 'image' ? 'image' : 'film'} />
        <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {primary.name}
          {ids.length > 1 ? ` (+${ids.length - 1})` : ''}
        </span>
        <span className="hint" style={{ textTransform: 'none' }}>
          {primary.duration.toFixed(2)}s
        </span>
      </div>
      <div className="insp-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={active === t.id ? 'on' : ''} onClick={() => setUI({ inspectorTab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {primary.kind === 'image' && primary.mediaId && media[primary.mediaId] && (
          <div className="section" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="primary small"
              title="Cut out this image: makes its background transparent and swaps the clip to the transparent PNG"
              onClick={() => {
                const mid = primary.mediaId!;
                const clipId = primary.id;
                void openRemoveBackground(media[mid].path, (newId) =>
                  commit((d) => {
                    if (d.clips[clipId]) d.clips[clipId].mediaId = newId;
                  }),
                );
              }}
            >
              <Icon name="cutout" size={13} /> Remove background
            </button>
            <span className="hint">Makes the background see-through (great for logos and characters)</span>
          </div>
        )}
        {active === 'video' && <TransformPanel clip={primary} ed={ed} />}
        {active === 'speed' && <SpeedPanel clip={primary} ed={ed} />}
        {active === 'color' && <ColorPanel clip={primary} ed={ed} />}
        {active === 'effects' && <EffectsPanel clip={primary} ed={ed} />}
        {active === 'audio' && <AudioPanelSwitch primary={primary} audio={audioClip} />}
        {active === 'text' && <TextPanel clip={primary} ed={ed} />}
      </div>
    </div>
  );
}

function AudioPanelSwitch({ primary, audio }: { primary: Clip; audio?: Clip }): React.ReactElement {
  // If a linked audio clip is selected together with the video, edit the audio clip.
  const target = primary.audioDetached && audio ? audio : primary;
  const ed = useEditor([target.id]);
  return <AudioPanel clip={target} ed={ed} />;
}
