import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { openRemoveBackground } from './logo/LogoMaker';
import { Tip } from './Hints';
import { setRT, setUI, toast, useStore, getState } from '../store/store';
import { appendToTimeline, detectBeatsFor, importFiles, removeMedia, ensureMediaRuntime } from '../store/actions';
import type { MediaItem } from '../../shared/types';
import { ALL_MEDIA_EXTS, AUDIO_EXTS, basename } from '../../shared/defaults';
import { shortDuration } from '../../shared/time';
import { openContextMenu } from './ContextMenu';
import { commit } from '../store/store';

export const DND_MEDIA = 'application/x-uts-media';
export const DND_SFX_FILE = 'application/x-uts-sfx-file';

const FILTERS: { id: ReturnType<typeof getState>['ui']['binFilter']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'image', label: 'Images' },
  { id: 'music', label: 'Music' },
  { id: 'sfx', label: 'SFX' },
];

export async function pickAndImport(): Promise<void> {
  const files = await window.api.openFiles({
    title: 'Import media',
    multi: true,
    filters: [
      { name: 'Media', extensions: ALL_MEDIA_EXTS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (files.length) await importFiles(files);
}

export async function chooseSfxFolder(): Promise<void> {
  const r = await window.api.openFiles({ title: 'Choose your sound effects folder', folder: true });
  if (!r.length) return;
  const settings = await window.api.updateSettings({ sfxFolder: r[0] });
  setRT({ settings });
  await refreshSfx();
  setUI({ binFilter: 'sfx' });
}

export async function refreshSfx(): Promise<void> {
  const folder = getState().rt.settings?.sfxFolder;
  if (!folder) return;
  const files = await window.api.listFolder(folder, AUDIO_EXTS);
  setRT({ sfxFiles: files });
}

function MediaCard({ m }: { m: MediaItem }): React.ReactElement {
  const thumb = useStore((s) => s.rt.thumbs[m.id]);
  const proxy = useStore((s) => s.rt.proxies[m.id]);
  const usedCount = useStore((s) => Object.values(s.project.clips).filter((c) => c.mediaId === m.id).length);
  const icon = <Icon name={m.kind === 'audio' ? (m.folder === 'music' ? 'music' : 'sfx') : m.kind === 'image' ? 'image' : 'film'} size={26} />;
  const sub =
    m.kind === 'image'
      ? `${m.width}×${m.height}`
      : m.kind === 'audio'
        ? `${shortDuration(m.duration)} · ${m.sampleRate / 1000}kHz${m.bpm ? ` · ${m.bpm} BPM` : ''}`
        : `${m.width}×${m.height} · ${Math.round(m.fps)}fps`;
  return (
    <div
      className={'bin-item' + (m.missing ? ' missing' : '')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MEDIA, m.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={() => appendToTimeline(m.id)}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { header: m.name },
          { label: 'Append to timeline', onClick: () => appendToTimeline(m.id) },
          ...(m.kind === 'image' ? [{ label: 'Remove background…', onClick: () => void openRemoveBackground(m.path) }] : []),
          ...(m.hasAudio ? [{ label: 'Detect beats', onClick: () => detectBeatsFor(m.id) }] : []),
          { label: 'Move to Music', onClick: () => commit((p) => void (p.media[m.id].folder = 'music')) },
          { label: 'Move to SFX', onClick: () => commit((p) => void (p.media[m.id].folder = 'sfx')) },
          { label: 'Move to Media', onClick: () => commit((p) => void (p.media[m.id].folder = 'media')) },
          { label: 'Show in folder', onClick: () => window.api.showInFolder(m.path) },
          ...(m.missing ? [{ label: 'Relink…', onClick: () => setUI({ dialog: 'relink' }) }] : []),
          ...(proxy?.state === 'error' ? [{ label: 'Retry preview copy', onClick: () => { setRT((r) => { const p = { ...r.proxies }; delete p[m.id]; return { proxies: p }; }); ensureMediaRuntime(m); } }] : []),
          { sep: true },
          {
            label: usedCount ? `Remove (and ${usedCount} clip${usedCount > 1 ? 's' : ''})` : 'Remove from project',
            onClick: () => removeMedia([m.id]),
          },
        ])
      }
      title={`${m.path}${m.missing ? '\nMISSING — right-click and choose Relink' : ''}`}
    >
      <div className="thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
        {!thumb && icon}
        {m.kind !== 'image' && <span className="dur">{shortDuration(m.duration)}</span>}
        {m.missing && <span className="badge" style={{ color: 'var(--danger)' }}>MISSING</span>}
        {!m.missing && proxy && (proxy.state === 'queued' || proxy.state === 'running') && (
          <div className="prep-overlay" title="IslandCut is making a smooth preview copy of this clip. You can already use it; playback gets smooth when this is done.">
            <span className="spin" />
            <b>{proxy.state === 'queued' ? 'Waiting…' : `Preparing ${Math.round(proxy.progress * 100)}%`}</b>
            <span>{proxy.state === 'queued' ? 'next in line' : 'for smooth preview'}</span>
          </div>
        )}
        {!m.missing && proxy?.state === 'error' && <span className="badge" style={{ color: 'var(--danger)' }}>preview copy failed · right-click → Retry</span>}
        {usedCount > 0 && <span className="badge" style={{ left: 'auto', right: 4, top: 4, color: '#8db2ff' }}>{usedCount}×</span>}
        {m.kind === 'image' && !m.missing && (
          <button
            className="bin-quick"
            title="Remove this image's background (makes a transparent PNG copy)"
            onClick={(e) => {
              e.stopPropagation();
              void openRemoveBackground(m.path);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Icon name="cutout" size={13} /> Remove BG
          </button>
        )}
      </div>
      <div className="meta">
        <div className="name">{m.name}</div>
        <div className="sub">{sub}</div>
      </div>
      {proxy && (proxy.state === 'running' || proxy.state === 'queued') && (
        <div className="proxybar">
          <div style={{ width: `${proxy.progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}

let builtinLoading: Promise<void> | null = null;
/** Generate (first time) and list the built-in sounds. */
export function loadBuiltinSfx(): Promise<void> {
  if (!builtinLoading)
    builtinLoading = window.api
      .builtinSfx()
      .then((list) => setRT({ builtinSfx: list }))
      .catch((e) => {
        builtinLoading = null;
        toast(`Could not make the built-in sounds: ${(e as Error).message}`, 'error');
      });
  return builtinLoading;
}

function SfxCard({ path, label, sub }: { path: string; label?: string; sub?: string }): React.ReactElement {
  return (
    <div
      className="bin-item"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_SFX_FILE, path);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={async () => {
        const [m] = await importFiles([path], 'sfx');
        if (m) appendToTimeline(m.id);
      }}
      title={path}
    >
      <div className="thumb" style={{ aspectRatio: '4/1' }}>
        <Icon name="sfx" size={20} />
      </div>
      <div className="meta">
        <div className="name">{label ?? basename(path)}</div>
        <div className="sub">{sub ?? 'SFX folder'}</div>
      </div>
    </div>
  );
}

export function MediaBin(): React.ReactElement {
  const media = useStore((s) => s.project.media);
  const filter = useStore((s) => s.ui.binFilter);
  const sfxFiles = useStore((s) => s.rt.sfxFiles);
  const sfxFolder = useStore((s) => s.rt.settings?.sfxFolder);
  const [drag, setDrag] = useState(false);
  const [q, setQ] = useState('');
  const builtin = useStore((s) => s.rt.builtinSfx);
  const importing = useStore((s) => s.rt.importing);
  useEffect(() => {
    if (filter === 'sfx') void loadBuiltinSfx();
  }, [filter]);
  const items = Object.values(media)
    .filter((m) => {
      if (q && !m.name.toLowerCase().includes(q.toLowerCase())) return false;
      switch (filter) {
        case 'video':
          return m.kind === 'video';
        case 'audio':
          return m.kind === 'audio';
        case 'image':
          return m.kind === 'image';
        case 'music':
          return m.folder === 'music';
        case 'sfx':
          return m.folder === 'sfx';
        default:
          return true;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const importedSfx = new Set(Object.values(media).map((m) => m.path));
  const folderSfx = filter === 'sfx' ? sfxFiles.filter((f) => !importedSfx.has(f) && (!q || basename(f).toLowerCase().includes(q.toLowerCase()))) : [];
  const builtinShown = filter === 'sfx' ? builtin.filter((b) => !importedSfx.has(b.path) && (!q || b.name.toLowerCase().includes(q.toLowerCase()))) : [];

  return (
    <div className="panel" data-tour="bin">
      <div className="panel-head">
        <Icon name="folder" />
        <span className="grow">Media</span>
        <button className="small primary" onClick={pickAndImport} title="Import clips, music, sound effects or images (Ctrl+I)">
          <Icon name="import" size={14} /> Import
        </button>
      </div>
      <div className="bin-tabs">
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setUI({ binFilter: f.id })}>
            {f.label}
          </button>
        ))}
        <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} style={{ flex: 1, minWidth: 70, padding: '2px 6px' }} />
      </div>
      <div
        className={'panel-body' + (drag ? ' dropzone-active' : '')}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDrag(false);
          const paths = Array.from(e.dataTransfer.files).map((f) => window.api.getPathForFile(f)).filter(Boolean);
          if (paths.length) await importFiles(paths, filter === 'sfx' ? 'sfx' : filter === 'music' ? 'music' : undefined);
        }}
      >
        {filter === 'sfx' && (
          <div style={{ padding: '8px 8px 0', display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="small" onClick={chooseSfxFolder}>
              {sfxFolder ? 'Change SFX folder' : 'Choose SFX folder…'}
            </button>
            {sfxFolder && (
              <button className="small" onClick={() => refreshSfx().then(() => toast('SFX folder refreshed', 'info', 1200))} title={sfxFolder}>
                <Icon name="reset" size={13} />
              </button>
            )}
            <span className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sfxFolder}>
              {sfxFolder ? basename(sfxFolder) : 'whooshes, hits, risers…'}
            </span>
          </div>
        )}
        {items.length > 0 && (
          <Tip id="bin-drag">Drag a clip onto the timeline below, or double-click it to add it at the end. Right-click for more options.</Tip>
        )}
        {builtinShown.length > 0 && (
          <>
            <div className="bin-group">Built-in sounds · free to use · drag onto the timeline</div>
            <div className="bin-grid">
              {builtinShown.map((b) => (
                <SfxCard key={b.id} path={b.path} label={b.name} sub={b.use} />
              ))}
            </div>
            {(items.length > 0 || folderSfx.length > 0) && <div className="bin-group">Your sounds</div>}
          </>
        )}
        {items.some((m) => m.kind === 'image') && (filter === 'image' || filter === 'all') && (
          <Tip id="bin-removebg">Need a logo or character without its background? Hover an image and click “Remove BG” to make a transparent PNG.</Tip>
        )}
        {items.length === 0 && folderSfx.length === 0 && importing.length === 0 ? (
          builtinShown.length > 0 ? null : (
          <div className="empty-state">
            <div className="ring">
              <Icon name={filter === 'sfx' ? 'sfx' : 'import'} size={24} />
            </div>
            {filter === 'sfx' ? (
              <>Pick a folder with your whooshes, hits and risers, or drop sound files here.</>
            ) : (
              <>
                <div>
                  <b style={{ color: '#fff' }}>Drop your clips here</b>
                  <br />
                  gameplay recordings, music, sound effects, logos
                </div>
                <button className="primary" onClick={pickAndImport}>
                  <Icon name="import" size={14} /> Import files
                </button>
                <span className="hint">mp4 · mov · mkv · mp3 · wav · ogg · m4a · png · jpg</span>
              </>
            )}
          </div>
          )
        ) : (
          <div className="bin-grid">
            {importing.map((name, i) => (
              <div key={'imp' + i + name} className="bin-item importing" title="Adding this file to your project…">
                <div className="thumb">
                  <div className="prep-overlay">
                    <span className="spin" />
                    <b>Adding…</b>
                  </div>
                </div>
                <div className="meta">
                  <div className="name">{name}</div>
                  <div className="sub">reading the file</div>
                </div>
              </div>
            ))}
            {items.map((m) => (
              <MediaCard key={m.id} m={m} />
            ))}
            {folderSfx.map((f) => (
              <SfxCard key={f} path={f} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
