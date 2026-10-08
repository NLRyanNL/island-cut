import React, { useEffect, useState } from 'react';
import { Modal } from '../common';
import { commit, getState, setRT, setState, setUI, toast, useStore } from '../../store/store';
import { ensureMediaRuntime, newProject, openProject, setPreviewQuality, type PreviewQuality } from '../../store/actions';
import { TEMPLATES, buildTemplate } from '../../presets/templates';
import { ExportDialog, QueueDialog } from './ExportDialog';
import { basename } from '../../../shared/defaults';
import type { UiZoom } from '../../../shared/api';
import { chooseSfxFolder } from '../MediaBin';
import { AutoTrailerDialog } from '../autotrailer/AutoTrailerDialog';
import { LogoMaker } from '../logo/LogoMaker';
import { Mascot, resetTour, setHintsEnabled } from '../Hints';

function RelinkDialog(): React.ReactElement {
  const media = useStore((s) => s.project.media);
  const missing = Object.values(media).filter((m) => m.missing);
  const locate = async (id: string) => {
    const m = getState().project.media[id];
    const ext = m.path.split('.').pop() ?? '*';
    const r = await window.api.openFiles({ title: `Locate ${m.name}`, filters: [{ name: m.name, extensions: [ext, '*'] }] });
    if (!r.length) return;
    const found: Record<string, string> = { [id]: r[0] };
    // look for other missing files in the same folder
    const dir = r[0].replace(/[\\/][^\\/]+$/, '');
    const others = Object.values(getState().project.media).filter((x) => x.missing && x.id !== id);
    const hits = await window.api.findInFolder(dir, others.map((o) => basename(o.path)));
    for (const o of others) if (hits[basename(o.path)]) found[o.id] = hits[basename(o.path)];
    const paths = Object.values(found);
    const probes = await window.api.probe(paths);
    commit((p) => {
      Object.entries(found).forEach(([mid, path], i) => {
        const pr = probes[paths.indexOf(path)] ?? probes[i];
        const mm = p.media[mid];
        if (!pr?.ok) return;
        mm.path = path;
        mm.missing = false;
        mm.duration = pr.duration || mm.duration;
        mm.width = pr.width;
        mm.height = pr.height;
        mm.fps = pr.fps;
        mm.fileSize = pr.fileSize;
        mm.mtimeMs = pr.mtimeMs;
        mm.hasVideo = pr.hasVideo;
        mm.hasAudio = pr.hasAudio;
        mm.audioChannels = pr.audioChannels;
        mm.sampleRate = pr.sampleRate;
        mm.codec = pr.codec;
        if (pr.kind) mm.kind = pr.kind;
      });
    });
    // the replacement file needs fresh thumbnails / proxies
    setRT((r) => {
      const proxies = { ...r.proxies };
      const thumbs = { ...r.thumbs };
      for (const mid of Object.keys(found)) {
        delete proxies[mid];
        delete thumbs[mid];
      }
      return { proxies, thumbs };
    });
    for (const mid of Object.keys(found)) ensureMediaRuntime(getState().project.media[mid]);
    const n = Object.keys(found).length;
    toast(`Relinked ${n} file${n > 1 ? 's' : ''}`, 'success');
  };
  return (
    <Modal
      title="Relink media"
      onClose={() => setUI({ dialog: null })}
      footer={
        <button className="primary" onClick={() => setUI({ dialog: null })}>
          {missing.length ? 'Later' : 'Done'}
        </button>
      }
    >
      {missing.length === 0 ? (
        <div>All media is linked.</div>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            {missing.length} file{missing.length > 1 ? 's were' : ' was'} moved or deleted. Locate one and the others in the same folder are found automatically.
          </p>
          <div className="list">
            {missing.map((m) => (
              <div className="li" key={m.id}>
                <div className="grow">
                  <div>{m.name}</div>
                  <div className="hint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {m.path}
                  </div>
                </div>
                <button onClick={() => locate(m.id)}>Locate…</button>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function ReportDialog(): React.ReactElement {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  useEffect(() => {
    window.api.appInfo().then((i) => setRepo(i.updateRepo));
  }, []);
  const save = async () => {
    const s = getState();
    const kinds: Record<string, number> = {};
    for (const m of Object.values(s.project.media)) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
    const extra = [
      `project: ${Object.keys(s.project.clips).length} clips, media ${JSON.stringify(kinds)}, ${s.project.settings.width}x${s.project.settings.height} @ ${s.project.settings.fps} fps`,
      `screen: ${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}x, WebGL2: ${!!document.createElement('canvas').getContext('webgl2')}`,
      `exports: ${s.rt.queue.map((q) => `${q.job.kind} ${q.progress.status}${q.progress.status === 'error' ? ` (${q.progress.message})` : ''}`).join('; ') || 'none'}`,
    ].join('\n');
    const p = await window.api.createProblemReport(text, extra);
    if (p) setSaved(p);
  };
  return (
    <Modal title="Report a problem" onClose={() => setUI({ dialog: null })} footer={
      saved ? (
        <>
          <span className="grow" />
          {repo && <button onClick={() => window.api.openExternal(`https://github.com/${repo}/issues/new?title=${encodeURIComponent('Problem report')}`)}>Open GitHub</button>}
          <button className="primary" onClick={() => setUI({ dialog: null })}>Done</button>
        </>
      ) : (
        <>
          <span className="grow" />
          <button onClick={() => setUI({ dialog: null })}>Cancel</button>
          <button className="primary" onClick={save}>Save report</button>
        </>
      )
    }>
      <div className="wizard-buddy" style={{ marginBottom: 12 }}>
        <Mascot size={64} />
        <div>
          {saved ? (
            <>
              <b>Thanks! Your report is saved.</b>
              <div className="hint" style={{ marginTop: 4 }}>It's open in Explorer ({saved.split(/[\\/]/).pop()}). Send that file to the person you got IslandCut from{repo ? ', or attach it to a new issue on GitHub' : ''}.</div>
            </>
          ) : (
            <div className="hint">Tell Boo what went wrong. IslandCut saves a text file with your description and the app's log. Your name, user folder and API key are removed, and nothing is sent anywhere automatically.</div>
          )}
        </div>
      </div>
      {!saved && (
        <textarea rows={5} style={{ width: '100%' }} placeholder="What were you doing, and what happened? e.g. 'I clicked Export and it stopped at 40%'" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      )}
    </Modal>
  );
}

function InterfaceSize(): React.ReactElement {
  const [z, setZ] = useState<UiZoom | null>(null);
  useEffect(() => {
    window.api.getUiZoom().then(setZ);
  }, []);
  if (!z) return <span className="hint">…</span>;
  const opts: (number | null)[] = [null, 0.9, 1, 1.15, 1.3, 1.5];
  return (
    <div>
      <div className="chips">
        {opts.map((o) => (
          <button key={String(o)} className={z.setting === o ? 'on' : ''} onClick={async () => setZ(await window.api.setUiZoom(o))}>
            {o === null ? `Auto (${Math.round(z.auto * 100)}%)` : `${Math.round(o * 100)}%`}
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 4 }}>Makes all text and buttons bigger or smaller. Auto picks a size that fits your screen.</div>
    </div>
  );
}

function SettingsDialog(): React.ReactElement {
  const settings = useStore((s) => s.rt.settings);
  const showHints = useStore((s) => s.ui.showHints);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(settings?.aiModel ?? '');
  const saveKey = async (k: string | null) => {
    const s = await window.api.setApiKey(k);
    setRT({ settings: s });
    setKey('');
    toast(k ? 'API key saved (encrypted on this PC)' : 'API key removed', 'success');
  };
  return (
    <Modal title="Settings" onClose={() => setUI({ dialog: null })} footer={<button className="primary" onClick={() => setUI({ dialog: null })}>Close</button>}>
      <div className="form-grid">
        <label>Sound effects folder</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {settings?.sfxFolder ?? 'not set'}
          </span>
          <button onClick={chooseSfxFolder}>Choose…</button>
        </div>
        <label>Autosave</label>
        <span className="hint">Recovery copy every 30 seconds (your project file only changes when you Save)</span>
        <label>Anthropic API key</label>
        <div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="password"
              placeholder={settings?.hasApiKey ? '•••••••• (saved)' : 'sk-ant-…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              style={{ flex: 1 }}
            />
            <button className="primary" disabled={!key.trim()} onClick={() => saveKey(key.trim())}>
              Save
            </button>
            {settings?.hasApiKey && (
              <button className="danger" onClick={() => saveKey(null)}>
                Remove
              </button>
            )}
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Optional. Used by Auto Trailer to write concepts and check frames for HUD / gunfire. Stored encrypted with Windows' data protection, never in project files.
          </div>
        </div>
        <label>Preview quality</label>
        <div>
          <select value={settings?.previewQuality ?? 'high'} onChange={(e) => void setPreviewQuality(e.target.value as PreviewQuality)}>
            <option value="smooth">Smooth: 540p, fastest on slow PCs</option>
            <option value="high">High: 1080p, sharp (recommended)</option>
            <option value="original">Original: full resolution (4K), needs a fast PC</option>
          </select>
          <div className="hint" style={{ marginTop: 4 }}>Only changes how the preview looks while you edit. Exports always use your full-quality clips.</div>
        </div>
        <label>Interface size</label>
        <InterfaceSize />
        <label>Beginner help</label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={showHints} onChange={(e) => setHintsEnabled(e.target.checked)} /> Show tips
          </label>
          <button
            className="small"
            onClick={() => {
              resetTour();
              setUI({ dialog: null, tour: true });
            }}
          >
            Replay the tour
          </button>
        </div>
        {settings?.statsEnabled && (
          <>
            <label>Usage count</label>
            <div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={!settings.usageStatsOff}
                  onChange={async (e) => setRT({ settings: await window.api.updateSettings({ usageStatsOff: !e.target.checked }) })}
                />
                Count my install anonymously
              </label>
              <div className="hint" style={{ marginTop: 4 }}>Sends a random ID once a day so the creator knows how many people use IslandCut. No name, files or PC details.</div>
            </div>
          </>
        )}
        <label>AI model</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input type="text" value={model} placeholder="automatic (newest Sonnet model)" onChange={(e) => setModel(e.target.value)} onKeyDown={(e) => e.stopPropagation()} style={{ flex: 1 }} />
          <button
            onClick={async () => {
              const s = await window.api.updateSettings({ aiModel: model.trim() || undefined });
              setRT({ settings: s });
              toast('Saved', 'success', 1200);
            }}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['J / K / L', 'Shuttle reverse / stop / forward (press again for faster)'],
  ['← / →', 'Step one frame (Shift: 10 frames)'],
  ['↑ / ↓', 'Previous / next edit point'],
  ['Home / End', 'Go to start / end'],
  ['C or Ctrl+B', 'Split at playhead'],
  ['Delete / Backspace', 'Delete selected clips'],
  ['Shift+Delete', 'Ripple delete (close the gap)'],
  ['M', 'Add marker'],
  ['I / O', 'Set In / Out point'],
  ['+ / −', 'Timeline zoom'],
  ['Shift+Z', 'Zoom to fit'],
  ['S', 'Toggle snapping (hold Alt while dragging to bypass)'],
  ['T', 'Add text at playhead'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+A', 'Select all clips'],
  ['Ctrl+D', 'Duplicate selected clips'],
  ['Ctrl+S / Ctrl+Shift+S', 'Save / Save as'],
  ['Ctrl+I', 'Import media'],
  ['Ctrl+E', 'Export'],
  ['Ctrl+Shift+E', 'Export frame as PNG'],
  ['Alt+click volume line', 'Add volume keyframe'],
];

function ShortcutsDialog(): React.ReactElement {
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setUI({ dialog: null })}>
      <table className="shortcut-table">
        <tbody>
          {SHORTCUTS.map(([k, d]) => (
            <tr key={k}>
              <td>
                {k.split(' / ').map((x) => (
                  <span key={x} className="kbd">
                    {x}
                  </span>
                ))}
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function NewProjectDialog(): React.ReactElement {
  const [fps, setFps] = useState(60);
  const create = async (id: string) => {
    setUI({ dialog: null });
    await newProject(TEMPLATES.find((t) => t.id === id)?.aspect ?? '16:9', fps, buildTemplate(id, fps));
    if (id !== 'empty') toast('Template created — drop your clips onto the timeline between the section markers.', 'success', 6000);
  };
  return (
    <Modal title="New project from template" wide onClose={() => setUI({ dialog: null })}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <span className="hint">Frame rate</span>
        <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
          {[30, 60].map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        {TEMPLATES.map((t) => (
          <div key={t.id} className="list" style={{ padding: 14, cursor: 'pointer' }} onClick={() => create(t.id)}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t.name}</div>
            <div className="hint">{t.description}</div>
            <div className="hint" style={{ marginTop: 6 }}>
              {t.aspect}
              {t.duration ? ` · ${t.duration}s` : ''}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function RecoverDialog(): React.ReactElement {
  const [list, setList] = useState<{ path: string; name: string; modified: number }[]>([]);
  useEffect(() => {
    window.api.listAutosaves().then(setList);
  }, []);
  return (
    <Modal title="Recover autosave" onClose={() => setUI({ dialog: null })}>
      {list.length === 0 ? (
        <div className="hint">No autosaves found.</div>
      ) : (
        <div className="list">
          {list.slice(0, 20).map((a) => (
            <div className="li" key={a.path}>
              <div className="grow">
                <div>{a.name}</div>
                <div className="hint">{new Date(a.modified).toLocaleString()}</div>
              </div>
              <button
                onClick={async () => {
                  setUI({ dialog: null });
                  await openProject(a.path);
                  // a recovered copy must not be saved back into the cache folder
                  if (getState().projectPath === a.path) setState({ projectPath: null, dirty: true });
                  toast('Recovered — use File → Save As to keep it.', 'info', 6000);
                }}
              >
                Open
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function Dialogs(): React.ReactElement | null {
  const d = useStore((s) => s.ui.dialog);
  switch (d) {
    case 'export':
      return <ExportDialog />;
    case 'queue':
      return <QueueDialog />;
    case 'relink':
      return <RelinkDialog />;
    case 'settings':
      return <SettingsDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'newProject':
      return <NewProjectDialog />;
    case 'recover':
      return <RecoverDialog />;
    case 'autoTrailer':
      return <AutoTrailerDialog />;
    case 'logoMaker':
      return <LogoMaker />;
    case 'report':
      return <ReportDialog />;
    default:
      return null;
  }
}
