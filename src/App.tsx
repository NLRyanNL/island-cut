import React, { useEffect, useRef } from 'react';
import { getState, setRT, setUI, subscribe, toast, useStore } from './store/store';
import { MediaBin, refreshSfx } from './components/MediaBin';
import { Preview } from './components/Preview';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/timeline/Timeline';
import { ContextMenuHost, openContextMenu } from './components/ContextMenu';
import { Toasts } from './components/common';
import { Mascot } from './components/Hints';
import { checkUpdates } from './updates';
import { Dialogs } from './components/dialogs/Dialogs';
import { useShortcuts, runCommand } from './hooks/useShortcuts';
import { confirmDiscard, importFiles, updateTitle, previewProxyHeight } from './store/actions';
import { addTitlePreset } from './presets/templates';
import { exportAudio, exportFramePng } from './components/dialogs/ExportDialog';
import { Icon } from './components/Icon';
import { Tour, shouldShowTour, setHintsEnabled } from './components/Hints';

function TopBar(): React.ReactElement {
  const name = useStore((s) => s.project.name);
  const dirty = useStore((s) => s.dirty);
  const busy = useStore((s) => s.rt.busy);
  const proxyBusy = useStore((s) => Object.values(s.rt.proxies).filter((p) => p.state === 'running' || p.state === 'queued').length);
  const proxyPct = useStore((s) => {
    const r = Object.values(s.rt.proxies).find((p) => p.state === 'running');
    return r ? Math.round(r.progress * 100) : -1;
  });
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const queue = useStore((s) => s.rt.queue);
  const showHints = useStore((s) => s.ui.showHints);
  const running = queue.find((q) => q.progress.status === 'running' || q.progress.status === 'preparing');
  const pending = queue.filter((q) => q.progress.status === 'queued' || q.progress.status === 'running' || q.progress.status === 'preparing').length;
  const aspect = useStore((s) => s.project.settings.aspect);
  const fps = useStore((s) => s.project.settings.fps);
  return (
    <div className="topbar">
      <div className="brand">
        <Mascot size={28} className="logo boo" />
        IslandCut
      </div>
      <span className="projname" title={name}>
        {name}
        {dirty ? ' •' : ''}
      </span>
      <span className="hint">
        {aspect} · {fps} fps
      </span>
      <span className="sep" />
      <button className="ghost small" onClick={() => runCommand('new')} title="New project or start from a template (Ctrl+N)">
        <Icon name="newFile" size={15} /> <span className="lbl">New</span>
      </button>
      <button className="ghost small" onClick={() => runCommand('open')} title="Open a saved project (Ctrl+O)">
        <Icon name="folder" size={15} /> <span className="lbl">Open</span>
      </button>
      <button className="ghost small" onClick={() => runCommand('save')} title="Save the project (Ctrl+S) — it also autosaves every 30 seconds">
        <Icon name="save" size={15} /> <span className="lbl">Save</span>
      </button>
      <span className="sep" />
      <button className="ghost icon" disabled={!canUndo} onClick={() => runCommand('undo')} title="Undo (Ctrl+Z)">
        <Icon name="undo" />
      </button>
      <button className="ghost icon" disabled={!canRedo} onClick={() => runCommand('redo')} title="Redo (Ctrl+Y)">
        <Icon name="redo" />
      </button>
      <span className="sep" />
      <button
        className="ghost small"
        title="Add a ready-made title at the playhead"
        onClick={(e) =>
          openContextMenu(e, [
            { header: 'Add title at the playhead' },
            { label: 'COMING SOON', onClick: () => addTitlePreset('comingSoon') },
            { label: 'PLAY NOW', onClick: () => addTitlePreset('playNow') },
            { label: 'End card (title + island code)', onClick: () => addTitlePreset('endCard') },
            { label: 'Lower third (feature callout)', onClick: () => addTitlePreset('lowerThird') },
            { label: 'Slam title', onClick: () => addTitlePreset('slam') },
          ])
        }
      >
        <Icon name="text" size={15} /> <span className="lbl keep">Titles</span> <Icon name="chevronDown" size={12} />
      </button>
      <button className="ghost small" data-tour="auto" onClick={() => runCommand('autoTrailer')} title="Let IslandCut build a trailer from your clips">
        <Icon name="sparkle" size={15} /> <span className="lbl keep">Auto Trailer</span>
      </button>
      <button className="ghost small" onClick={() => runCommand('logoMaker')} title="Logo Maker: make a transparent PNG logo for your island">
        <Icon name="image" size={15} /> <span className="lbl">Logo</span>
      </button>
      <button className="ghost small" onClick={() => runCommand('removeBg')} title="Remove the background from an image (logos, characters, renders) and save it as a transparent PNG">
        <Icon name="cutout" size={15} /> <span className="lbl keep">Remove BG</span>
      </button>
      <span className="spacer" />
      <UpdateBanner />
      {proxyBusy > 0 && !busy && (
        <span className="busy busy-pill" title="New clips are being prepared for smooth playback. You can keep editing while this runs; it only affects the preview, never your export.">
          <Mascot size={18} /> Preparing {proxyBusy} clip{proxyBusy > 1 ? 's' : ''}{proxyPct >= 0 ? ` · ${proxyPct}%` : ''}…
        </span>
      )}
      {busy && (
        <span className="busy busy-pill">
          <Mascot size={18} />
          {busy}
        </span>
      )}
      {running && (
        <span className="busy busy-pill" style={{ cursor: 'pointer' }} onClick={() => setUI({ dialog: 'queue' })} title="Open the render queue">
          <Mascot size={18} />
          Exporting {Math.round(running.progress.progress * 100)}%
        </span>
      )}
      <button className="ghost small" onClick={() => setUI({ dialog: 'queue' })} title="Render queue: all your exports">
        <Icon name="queue" size={15} /> <span className="lbl">Queue</span>{pending ? ` (${pending})` : ''}
      </button>
      <button className="ghost small" onClick={exportFramePng} title="Save the current frame as a PNG — great for thumbnails (Ctrl+Shift+E)">
        <Icon name="camera" size={15} /> <span className="lbl">Snapshot</span>
      </button>
      <button
        className="ghost small"
        title="Export only the audio"
        onClick={(e) =>
          openContextMenu(e, [
            { label: 'Timeline audio as WAV…', onClick: () => exportAudio('audio-wav') },
            { label: 'Timeline audio as MP3…', onClick: () => exportAudio('audio-mp3') },
          ])
        }
      >
        <Icon name="audio" size={15} /> <span className="lbl">Audio</span> <Icon name="chevronDown" size={12} />
      </button>
      <button
        className="ghost icon"
        title="Help"
        onClick={(e) =>
          openContextMenu(e, [
            { label: 'Show the quick tour', onClick: () => setUI({ tour: true }) },
            { label: 'Keyboard shortcuts', shortcut: 'F1', onClick: () => setUI({ dialog: 'shortcuts' }) },
            { label: showHints ? 'Hide beginner tips' : 'Show beginner tips', onClick: () => setHintsEnabled(!showHints) },
            { sep: true },
            { label: 'Check for updates', onClick: () => checkUpdates(true) },
            { label: 'Report a problem…', onClick: () => setUI({ dialog: 'report' }) },
          ])
        }
      >
        <Icon name="help" />
      </button>
      <button className="ghost icon" onClick={() => setUI({ dialog: 'settings' })} title="Settings">
        <Icon name="settings" />
      </button>
      <button className="primary" data-tour="export" onClick={() => setUI({ dialog: 'export' })} title="Export your video (Ctrl+E)">
        <Icon name="export" size={15} /> Export
      </button>
    </div>
  );
}

function UpdateBanner(): React.ReactElement | null {
  const u = useStore((s) => s.rt.update);
  if (!u || u.status !== 'available' || !u.url) return null;
  return (
    <span className="update-pill" title={u.notes || 'A newer version of IslandCut is available'}>
      <Mascot size={20} />
      <span>
        New version <b>{u.latest}</b>
      </span>
      <button className="primary small" onClick={() => window.api.openExternal(u.url!)}>
        Download
      </button>
      <button className="ghost icon small" title="Not now (asks again next time you start IslandCut)" onClick={() => setRT({ update: null })}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

function useAutosave(): void {
  const last = useRef<number>(0);
  useEffect(() => {
    const id = setInterval(async () => {
      const s = getState();
      if (!s.dirty || Object.keys(s.project.clips).length === 0) return;
      if (s.ui.revision === last.current) return;
      last.current = s.ui.revision;
      try {
        // recovery copy only; the project stays marked unsaved until the user saves
        await window.api.autosave(s.project, s.projectPath);
      } catch (e) {
        toast(`Autosave failed: ${(e as Error).message}`, 'error');
      }
    }, 30_000);
    return () => clearInterval(id);
  }, []);
}

export function App(): React.ReactElement {
  const tlh = useStore((s) => s.ui.timelineHeight);
  const tour = useStore((s) => s.ui.tour);
  useEffect(() => {
    if (shouldShowTour()) setTimeout(() => setUI({ tour: true }), 600);
    if (!window.api.selftest && !window.api.testMode) setTimeout(() => void checkUpdates(false), 4000);
  }, []);
  useShortcuts();
  useAutosave();

  useEffect(() => {
    const offProxy = window.api.onProxyProgress((p) => {
      // ignore a job for the other preview quality (still finishing after the user switched)
      if (p.height && p.height !== previewProxyHeight()) return;
      setRT((rt) => ({ proxies: { ...rt.proxies, [p.mediaId]: { ...rt.proxies[p.mediaId], ...p } } }));
      if (p.state === 'error') toast(`Couldn't prepare a preview copy of a clip (it still exports fine): ${p.error}`, 'error');
    });
    const offMenu = window.api.onMenu((cmd) => runCommand(cmd));
    // files dropped anywhere that has no drop zone of its own are imported (never opened as a page)
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      if (e.defaultPrevented) return; // a drop zone already handled it
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files).map((f) => window.api.getPathForFile(f)).filter(Boolean);
      if (paths.length) void importFiles(paths);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    const offClose = window.api.onCloseRequested(async () => {
      if (await confirmDiscard()) window.api.confirmClose();
    });
    window.api.getSettings().then((settings) => {
      setRT({ settings });
      if (settings.sfxFolder) refreshSfx();
    });
    // keep the window title in sync with name/dirty state
    let lastTitle = '';
    const unsub = subscribe(() => {
      const s = getState();
      const t = `${s.project.name}|${s.dirty}`;
      if (t !== lastTitle) {
        lastTitle = t;
        updateTitle();
      }
    });
    updateTitle();
    return () => {
      offProxy();
      offMenu();
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      offClose();
      unsub();
    };
  }, []);

  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = getState().ui.timelineHeight;
    const move = (ev: PointerEvent) => setUI({ timelineHeight: Math.max(180, Math.min(window.innerHeight - 260, h0 - (ev.clientY - y0))) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="app" style={{ ['--tlh' as string]: `${tlh}px` }} onContextMenu={(e) => e.preventDefault()}>
      <TopBar />
      <div className="main">
        <MediaBin />
        <Preview />
        <Inspector />
      </div>
      <div className="splitter" onPointerDown={startResize} />
      <Timeline />
      <Dialogs />
      <ContextMenuHost />
      {tour && <Tour onClose={() => setUI({ tour: false })} />}
      <Toasts />
    </div>
  );
}
