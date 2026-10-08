import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { Modal } from '../common';
import { getState, setRT, setUI, toast, useStore } from '../../store/store';
import type { ExportJob, ExportKind, ExportPreset, Project } from '../../../shared/types';
import { BUILTIN_PRESETS } from '../../../shared/defaults';
import { clipEnd, projectDuration, withLinked } from '../../../shared/timelineOps';
import { clipHasAudio } from '../../../shared/evaluate';
import { cancelJob, clearFinished, enqueue } from '../../export/queue';
import { BooBusy } from '../BooBusy';
import { Mascot } from '../Hints';
import { uid, timecode } from '../../../shared/time';

function allPresets(custom: ExportPreset[]): ExportPreset[] {
  // custom presets with a built-in id override the built-in one (e.g. the edited Fortnite preset)
  const byId = new Map(BUILTIN_PRESETS.map((p) => [p.id, p]));
  for (const c of custom) byId.set(c.id, { ...c, builtIn: byId.get(c.id)?.builtIn ?? false });
  return [...byId.values()];
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'export';
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

export function ExportDialog(): React.ReactElement {
  const project = useStore((s) => s.project);
  const settings = useStore((s) => s.rt.settings);
  const projectPath = useStore((s) => s.projectPath);
  const presets = useMemo(() => allPresets(settings?.customPresets ?? []), [settings]);
  const defaultPreset = project.settings.aspect === '9:16' ? 'shorts' : 'yt1080p60';
  const [presetId, setPresetId] = useState(defaultPreset);
  const base = presets.find((p) => p.id === presetId) ?? presets[0];
  const [preset, setPreset] = useState<ExportPreset>(base);
  const dur = projectDuration(project);
  const hasRange = project.inPoint !== undefined && project.outPoint !== undefined && project.outPoint > project.inPoint;
  const [range, setRange] = useState<'all' | 'inout'>(hasRange ? 'inout' : 'all');
  const [normalize, setNormalize] = useState(project.settings.normalizeLoudness);
  const [folder, setFolder] = useState(settings?.lastExportDir || (projectPath ? dirOf(projectPath) : ''));
  const [fileName, setFileName] = useState(`${safeName(project.name)} - ${base.name.replace(/\s*\(.*\)/, '')}`);

  useEffect(() => {
    setPreset(base);
    setFileName(`${safeName(project.name)} - ${safeName(base.name.replace(/\s*\(.*\)/, ''))}`);
  }, [presetId]);

  const r0 = range === 'inout' && hasRange ? project.inPoint! : 0;
  const r1 = range === 'inout' && hasRange ? project.outPoint! : dur;
  const len = Math.max(0, r1 - r0);
  const estMB = preset.bitrateMbps > 0 ? ((preset.bitrateMbps + preset.audioBitrateKbps / 1000) * len) / 8 : null;
  const warnings: string[] = [];
  if (len <= 0) warnings.push('The timeline is empty.');
  if (preset.maxDurationSec && len > preset.maxDurationSec) warnings.push(`This preset allows at most ${preset.maxDurationSec}s (timeline is ${len.toFixed(1)}s).`);
  if (preset.maxFileSizeMB && estMB && estMB > preset.maxFileSizeMB) warnings.push(`Estimated size ${estMB.toFixed(0)} MB is above the ${preset.maxFileSizeMB} MB limit — lower the bitrate.`);
  const projAspect = project.settings.width / project.settings.height;
  if (Math.abs(preset.width / preset.height - projAspect) > 0.02) warnings.push('Preset aspect ratio differs from the project — the video will get black bars. Change the project aspect (Inspector, nothing selected) to reframe instead.');
  if (Object.values(project.media).some((m) => m.missing)) warnings.push('Some media is missing. Relink it first.');

  const editable = true; // any preset can be tweaked for this export
  const savable = !!preset.editable || !preset.builtIn;
  const setP = (patch: Partial<ExportPreset>) => setPreset((p) => ({ ...p, ...patch }));

  const savePreset = async () => {
    const custom = [...(settings?.customPresets ?? []).filter((p) => p.id !== preset.id), { ...preset, builtIn: false }];
    const s = await window.api.updateSettings({ customPresets: custom });
    setRT({ settings: s });
    toast('Preset saved', 'success', 1500);
  };
  const saveAsNewPreset = async () => {
    const np = { ...preset, id: uid('pre_'), name: `${preset.name} (copy)`, builtIn: false, editable: true };
    const s = await window.api.updateSettings({ customPresets: [...(settings?.customPresets ?? []), np] });
    setRT({ settings: s });
    setPresetId(np.id);
  };

  const chooseFolder = async () => {
    const r = await window.api.openFiles({ title: 'Export folder', folder: true });
    if (r.length) setFolder(r[0]);
  };

  const go = async (openQueue: boolean) => {
    let dir = folder;
    if (!dir) {
      const p = await window.api.saveFile({ title: 'Export video', defaultPath: `${fileName}.mp4`, filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
      if (!p) return;
      dir = dirOf(p);
      setFolder(dir);
    }
    const outputPath = joinPath(dir, `${safeName(fileName)}.mp4`);
    const exists = (await window.api.exists([outputPath]))[0];
    if (exists) {
      const r = await window.api.confirm({ message: `${safeName(fileName)}.mp4 already exists.`, detail: 'Replace it?', buttons: ['Replace', 'Cancel'], cancelId: 1 });
      if (r === 1) return;
    }
    await window.api.allowPaths([outputPath]);
    const s = await window.api.updateSettings({ lastExportDir: dir });
    setRT({ settings: s });
    const job: ExportJob = {
      id: uid('job_'),
      kind: 'video',
      outputPath,
      preset,
      rangeStart: r0,
      rangeEnd: r1,
      normalizeLoudness: normalize,
      targetLufs: project.settings.targetLufs,
      label: `${preset.name} · ${timecode(len, preset.fps)}`,
    };
    enqueue(job);
    setUI({ dialog: openQueue ? 'queue' : null });
  };

  return (
    <Modal
      title="Export video"
      wide
      onClose={() => setUI({ dialog: null })}
      footer={
        <>
          <span className="hint grow">{estMB ? `≈ ${estMB.toFixed(0)} MB · ` : ''}H.{preset.codec === 'h265' ? '265' : '264'} + AAC · originals are used (not proxies)</span>
          <button onClick={() => setUI({ dialog: null })}>Cancel</button>
          <button onClick={() => go(false)} disabled={len <= 0}>
            Add to queue
          </button>
          <button className="primary" onClick={() => go(true)} disabled={len <= 0}>
            Export
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 18 }}>
        <div className="list" style={{ alignSelf: 'start' }}>
          {presets.map((p) => (
            <div key={p.id} className="li" style={{ cursor: 'pointer', background: p.id === presetId ? '#23406e' : undefined }} onClick={() => setPresetId(p.id)}>
              <div className="grow">
                <div>{p.name}</div>
                <div className="hint">
                  {p.width}×{p.height} · {p.fps}fps · {p.codec.toUpperCase()}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="form-grid">
            <label>File name</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={fileName} onChange={(e) => setFileName(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => e.stopPropagation()} />
              <span className="hint" style={{ alignSelf: 'center' }}>
                .mp4
              </span>
            </div>
            <label>Folder</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={folder} readOnly placeholder="(choose…)" style={{ flex: 1 }} />
              <button onClick={chooseFolder}>Browse…</button>
            </div>
            <label>Range</label>
            <select value={range} onChange={(e) => setRange(e.target.value as 'all' | 'inout')}>
              <option value="all">Whole timeline ({timecode(dur, project.settings.fps)})</option>
              <option value="inout" disabled={!hasRange}>
                In → Out {hasRange ? `(${timecode(project.outPoint! - project.inPoint!, project.settings.fps)})` : '(set I / O first)'}
              </option>
            </select>
            <label>Resolution</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="number" value={preset.width} disabled={!editable} onChange={(e) => setP({ width: Math.max(16, Math.round(Number(e.target.value) / 2) * 2) })} style={{ width: 80 }} />×
              <input type="number" value={preset.height} disabled={!editable} onChange={(e) => setP({ height: Math.max(16, Math.round(Number(e.target.value) / 2) * 2) })} style={{ width: 80 }} />
              <select disabled={!editable} value="" onChange={(e) => e.target.value && setP({ width: Number(e.target.value.split('x')[0]), height: Number(e.target.value.split('x')[1]) })}>
                <option value="">presets…</option>
                <option value="1280x720">720p</option>
                <option value="1920x1080">1080p</option>
                <option value="2560x1440">1440p</option>
                <option value="3840x2160">4K</option>
                <option value="1080x1920">1080×1920 vertical</option>
                <option value="1080x1080">1080 square</option>
              </select>
            </div>
            <label>Frame rate</label>
            <select value={preset.fps} disabled={!editable} onChange={(e) => setP({ fps: Number(e.target.value) })}>
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <label>Codec</label>
            <select value={preset.codec} disabled={!editable} onChange={(e) => setP({ codec: e.target.value as ExportPreset['codec'] })}>
              <option value="h264">H.264 (most compatible)</option>
              <option value="h265">H.265 / HEVC (smaller files)</option>
            </select>
            <label>Bitrate</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="number" value={preset.bitrateMbps} disabled={!editable} min={0} onChange={(e) => setP({ bitrateMbps: Math.max(0, Number(e.target.value)) })} style={{ width: 80 }} />
              <span className="hint">Mbit/s (0 = constant quality CRF</span>
              <input type="number" value={preset.crf} disabled={!editable} min={0} max={51} onChange={(e) => setP({ crf: Number(e.target.value) })} style={{ width: 56 }} />
              <span className="hint">)</span>
            </div>
            <label>Encoder speed</label>
            <select value={preset.speed} disabled={!editable} onChange={(e) => setP({ speed: e.target.value as ExportPreset['speed'] })}>
              {['ultrafast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <label>Audio</label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <select value={preset.audioBitrateKbps} disabled={!editable} onChange={(e) => setP({ audioBitrateKbps: Number(e.target.value) })}>
                {[128, 192, 256, 320].map((b) => (
                  <option key={b} value={b}>
                    AAC {b} kbps
                  </option>
                ))}
              </select>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
                Normalize to {project.settings.targetLufs} LUFS
              </label>
            </div>
            {editable && (
              <>
                <label>Limits</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className="hint">max length</span>
                  <input type="number" value={preset.maxDurationSec ?? 0} onChange={(e) => setP({ maxDurationSec: Number(e.target.value) || undefined })} style={{ width: 70 }} />
                  <span className="hint">s · max size</span>
                  <input type="number" value={preset.maxFileSizeMB ?? 0} onChange={(e) => setP({ maxFileSizeMB: Number(e.target.value) || undefined })} style={{ width: 70 }} />
                  <span className="hint">MB (0 = none)</span>
                </div>
                <label>Preset name</label>
                <input type="text" value={preset.name} onChange={(e) => setP({ name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                <label>Notes</label>
                <textarea rows={2} value={preset.notes ?? ''} onChange={(e) => setP({ notes: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                <span />
                <div style={{ display: 'flex', gap: 6 }}>
                  {savable && (
                    <button className="small" onClick={savePreset}>
                      Save preset
                    </button>
                  )}
                  <button className="small" onClick={saveAsNewPreset}>
                    Save as new…
                  </button>
                </div>
              </>
            )}
          </div>
          {preset.notes && !savable && <div className="hint" style={{ marginTop: 10 }}>{preset.notes}</div>}
          {warnings.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {warnings.map((w) => (
                <div key={w} style={{ color: 'var(--warn)', marginBottom: 6, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <Icon name="warning" size={14} style={{ marginTop: 2 }} /> {w}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ quick exports

function quickPreset(project: Project): ExportPreset {
  return { ...BUILTIN_PRESETS[0], width: project.settings.width, height: project.settings.height, fps: project.settings.fps };
}

export async function exportAudioForClips(ids: string[], kind: Extract<ExportKind, 'audio-mp3' | 'audio-wav'>): Promise<void> {
  const p = getState().project;
  const clips = withLinked(p, ids)
    .map((id) => p.clips[id])
    .filter((c) => c && clipHasAudio(p, c));
  if (!clips.length) {
    toast('The selected clip has no audio', 'error');
    return;
  }
  const a = Math.min(...clips.map((c) => c.start));
  const b = Math.max(...clips.map(clipEnd));
  await exportAudio(kind, a, b, clips.map((c) => c.id), clips[0].name);
}

export async function exportAudio(kind: Extract<ExportKind, 'audio-mp3' | 'audio-wav'>, a?: number, b?: number, only?: string[], name?: string): Promise<void> {
  const p = getState().project;
  const ext = kind === 'audio-mp3' ? 'mp3' : 'wav';
  const out = await window.api.saveFile({
    title: 'Export audio',
    defaultPath: `${safeName(name ?? p.name)}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (!out) return;
  const start = a ?? 0;
  const end = b ?? projectDuration(p);
  if (end - start <= 0) {
    toast('Nothing to export', 'error');
    return;
  }
  enqueue({
    id: uid('job_'),
    kind,
    outputPath: out,
    preset: quickPreset(p),
    rangeStart: start,
    rangeEnd: end,
    onlyClipIds: only,
    normalizeLoudness: !only && p.settings.normalizeLoudness,
    targetLufs: p.settings.targetLufs,
    label: `Audio ${ext.toUpperCase()} · ${(end - start).toFixed(1)}s`,
  });
  setUI({ dialog: 'queue' });
}

export async function exportFramePng(): Promise<void> {
  const s = getState();
  const p = s.project;
  const t = s.ui.playhead;
  const out = await window.api.saveFile({
    title: 'Export frame as PNG',
    defaultPath: `${safeName(p.name)} ${timecode(t, p.settings.fps).replace(/:/g, '-')}.png`,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (!out) return;
  // thumbnails are typically 1920x1080 (16:9) — render at project size, upscaled to at least 1080p
  const k = Math.max(1, 1080 / Math.min(p.settings.width, p.settings.height));
  enqueue({
    id: uid('job_'),
    kind: 'frame-png',
    outputPath: out,
    preset: { ...quickPreset(p), width: Math.round((p.settings.width * k) / 2) * 2, height: Math.round((p.settings.height * k) / 2) * 2 },
    rangeStart: t,
    rangeEnd: t,
    normalizeLoudness: false,
    targetLufs: -14,
    label: `Frame @ ${timecode(t, p.settings.fps)}`,
  });
  toast('Rendering frame from the original media…', 'info', 2000);
}

// ------------------------------------------------------------------ queue dialog

export function QueueDialog(): React.ReactElement {
  const queue = useStore((s) => s.rt.queue);
  return (
    <Modal
      title="Render queue"
      wide
      onClose={() => setUI({ dialog: null })}
      footer={
        <>
          <span className="hint grow">Jobs render one after another in the background. You can keep editing.</span>
          <button onClick={clearFinished}>Clear finished</button>
          <button onClick={() => setUI({ dialog: 'export' })}>+ Add export</button>
          <button className="primary" onClick={() => setUI({ dialog: null })}>
            Close
          </button>
        </>
      }
    >
      {(() => {
        const cur = queue.find((q) => q.progress.status === 'running' || q.progress.status === 'preparing') ?? queue.find((q) => q.progress.status === 'queued');
        if (cur) {
          const left = queue.filter((q) => ['queued', 'running', 'preparing'].includes(q.progress.status)).length;
          return (
            <BooBusy
              title={cur.progress.status === 'queued' ? 'Getting ready…' : `Rendering ${cur.job.outputPath.split(/[\\/]/).pop()}`}
              sub={`${cur.progress.message && cur.progress.message !== 'Rendering…' ? cur.progress.message + ' · ' : ''}You can keep editing while I work${left > 1 ? ` (${left} exports in line)` : ''}.`}
              progress={cur.progress.progress}
              eta={cur.progress.etaSec}
            />
          );
        }
        const last = queue[queue.length - 1];
        if (last?.progress.status === 'done')
          return (
            <div className="boo-busy small">
              <Mascot size={64} float />
              <div className="boo-busy-main">
                <div className="boo-busy-title">Your video is ready!</div>
                <div className="hint">{last.job.outputPath.split(/[\\/]/).pop()}</div>
              </div>
              <button className="primary" onClick={() => window.api.showInFolder(last.progress.outputPath ?? last.job.outputPath)}>
                Show in folder
              </button>
            </div>
          );
        return null;
      })()}
      {queue.length === 0 ? (
        <div className="hint">No exports yet.</div>
      ) : (
        <div className="list" style={{ maxHeight: 260, overflowY: 'auto' }}>
          {queue.map((q) => {
            const st = q.progress.status;
            return (
              <div className="li" key={q.job.id}>
                <div className="grow">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={q.job.outputPath}>
                      {q.job.outputPath.split(/[\\/]/).pop()}
                    </span>
                    <span className="hint">
                      {q.job.label} · {st}
                      {st === 'running' && q.progress.etaSec !== undefined ? ` · ${Math.ceil(q.progress.etaSec)}s left` : ''}
                      {st === 'running' && q.progress.fps ? ` · ${q.progress.fps.toFixed(0)} fps` : ''}
                    </span>
                  </div>
                  <div className={'progress' + (st === 'done' ? ' done' : st === 'error' ? ' err' : '')} style={{ marginTop: 6 }}>
                    <div style={{ width: `${Math.round((st === 'done' ? 1 : q.progress.progress) * 100)}%` }} />
                  </div>
                  {st === 'error' && <div className="err-text" style={{ marginTop: 6 }}>{q.progress.message}</div>}
                  {st === 'preparing' && q.progress.message && <div className="hint" style={{ marginTop: 6 }}>{q.progress.message}</div>}
                  {st === 'done' && q.progress.message && q.progress.message !== 'Done' && <div className="hint" style={{ marginTop: 4 }}>{q.progress.message}</div>}
                </div>
                {(st === 'queued' || st === 'running' || st === 'preparing') && (
                  <button className="danger small" onClick={() => cancelJob(q.job.id)}>
                    Cancel
                  </button>
                )}
                {st === 'done' && (
                  <button className="small" onClick={() => window.api.showInFolder(q.progress.outputPath ?? q.job.outputPath)}>
                    Show
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
