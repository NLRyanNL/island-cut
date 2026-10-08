import React, { useEffect, useRef, useState } from 'react';
import { PreviewEngine } from '../preview/PreviewEngine';
import { setUI, useStore, getState, commit } from '../store/store';
import { stepFrames, togglePlay, setPlayhead, openProject, setPreviewQuality } from '../store/actions';
import { openContextMenu } from './ContextMenu';
import { timecode } from '../../shared/time';
import { projectDuration } from '../../shared/timelineOps';
import { pickAndImport } from './MediaBin';
import { Icon } from './Icon';
import { Mascot } from './Hints';

let engineRef: PreviewEngine | null = null;
export function getEngine(): PreviewEngine | null {
  return engineRef;
}

function Timecode(): React.ReactElement {
  const t = useStore((s) => s.ui.playhead);
  const fps = useStore((s) => s.project.settings.fps);
  return <span className="timecode">{timecode(t, fps)}</span>;
}

function Duration(): React.ReactElement {
  const d = useStore((s) => projectDuration(s.project));
  const fps = useStore((s) => s.project.settings.fps);
  return <span className="timecode dim">{timecode(d, fps)}</span>;
}

export function Preview(): React.ReactElement {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const playing = useStore((s) => s.ui.playing);
  const rate = useStore((s) => s.ui.rate);
  const showSafe = useStore((s) => s.ui.showSafe);
  const showLb = useStore((s) => s.ui.showLetterboxGuide);
  const W = useStore((s) => s.project.settings.width);
  const H = useStore((s) => s.project.settings.height);
  const empty = useStore((s) => Object.keys(s.project.clips).length === 0 && Object.keys(s.project.media).length === 0);
  const hasInOut = useStore((s) => s.project.inPoint !== undefined || s.project.outPoint !== undefined);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!canvas.current || !overlay.current) return;
    try {
      engineRef = new PreviewEngine(canvas.current, overlay.current);
      engineRef.start();
    } catch (e) {
      setError((e as Error).message);
    }
    return () => {
      engineRef?.destroy();
      engineRef = null;
    };
  }, []);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const aspect = W / H;
      let w = r.width - 16;
      let h = w / aspect;
      if (h > r.height - 16) {
        h = r.height - 16;
        w = h * aspect;
      }
      setBox({ w: Math.max(10, w), h: Math.max(10, h) });
      engineRef?.resize(w, h, window.devicePixelRatio || 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  const style = { width: box.w, height: box.h };
  return (
    <div className="panel preview" data-tour="preview">
      <div className="preview-stage" ref={stage}>
        <canvas ref={canvas} style={style} />
        <canvas ref={overlay} style={{ ...style, background: 'transparent', boxShadow: 'none', pointerEvents: 'none' }} />
        {error && (
          <div className="welcome">
            <div className="card">
              <h2>Preview unavailable</h2>
              {error}
            </div>
          </div>
        )}
        {empty && !error && <HomeScreen />}
      </div>
      <div className="transport">
        <button className="ghost icon" title="Go to start (Home)" onClick={() => setPlayhead(0)}>
          <Icon name="toStart" />
        </button>
        <button className="ghost icon" title="Previous frame (Left arrow)" onClick={() => stepFrames(-1)}>
          <Icon name="stepBack" />
        </button>
        <button className="playbtn" title="Play / Pause (Space)" onClick={togglePlay}>
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <button className="ghost icon" title="Next frame (Right arrow)" onClick={() => stepFrames(1)}>
          <Icon name="stepForward" />
        </button>
        <button className="ghost icon" title="Go to end (End)" onClick={() => setPlayhead(projectDuration(getState().project))}>
          <Icon name="toEnd" />
        </button>
        {playing && rate !== 1 && <span className="hint">{rate > 0 ? `${rate}x` : `reverse ${-rate}x`}</span>}
        <Timecode />
        <span className="hint">/</span>
        <Duration />
        <span className="grow" />
        <button className="ghost small" title="Set the export start here (I)" onClick={() => commit((p) => void (p.inPoint = getState().ui.playhead))}>
          <Icon name="inPoint" size={14} /> In
        </button>
        <button className="ghost small" title="Set the export end here (O)" onClick={() => commit((p) => void (p.outPoint = getState().ui.playhead))}>
          <Icon name="outPoint" size={14} /> Out
        </button>
        {hasInOut && (
          <button className="ghost icon" title="Clear In/Out" onClick={() => commit((p) => { p.inPoint = undefined; p.outPoint = undefined; })}>
            <Icon name="close" size={13} />
          </button>
        )}
        <button className={'ghost small' + (showSafe ? ' on' : '')} title="Show safe-area guides (keeps text away from the edges)" onClick={() => setUI({ showSafe: !showSafe })}>
          <Icon name="grid" size={14} /> Safe
        </button>
        <button className={'ghost small' + (showLb ? ' on' : '')} title="Preview a 2.39:1 cinematic letterbox" onClick={() => setUI({ showLetterboxGuide: !showLb })}>
          <Icon name="letterbox" size={14} /> 2.39:1
        </button>
        <QualityButton />
      </div>
    </div>
  );
}

const QUALITY_LABEL = { smooth: 'Smooth', high: 'HD', original: 'Full' } as const;
function QualityButton(): React.ReactElement {
  const q = useStore((s) => s.rt.settings?.previewQuality ?? 'high');
  return (
    <button
      className="ghost small"
      title="Preview quality: how sharp the preview looks while editing (your export is always full quality)"
      onClick={(e) =>
        openContextMenu(e, [
          { header: 'Preview quality (export is always full quality)' },
          { label: `${q === 'smooth' ? '✓ ' : ''}Smooth: 540p, fastest on slow PCs`, onClick: () => void setPreviewQuality('smooth') },
          { label: `${q === 'high' ? '✓ ' : ''}High: 1080p, sharp (recommended)`, onClick: () => void setPreviewQuality('high') },
          { label: `${q === 'original' ? '✓ ' : ''}Original: full 4K file, needs a fast PC`, onClick: () => void setPreviewQuality('original') },
        ])
      }
    >
      <Icon name="eye" size={14} /> {QUALITY_LABEL[q]}
    </button>
  );
}

function HomeScreen(): React.ReactElement {
  const recent = useStore((s) => s.rt.settings?.recentProjects ?? []);
  return (
    <div className="welcome home">
      <div className="home-inner">
        <div className="home-hero">
          <Mascot size={92} float />
          <div>
            <h1>Make your island trailer</h1>
            <div className="home-sub">Hi, I'm Boo! Pick how you want to start. You can always change things later.</div>
          </div>
        </div>
        <div className="home-cards">
          <button className="home-card primary-card" onClick={() => setUI({ dialog: 'autoTrailer' })}>
            <span className="badge">Easiest</span>
            <Icon name="sparkle" size={28} />
            <b>Make it for me</b>
            <span>Add your clips and music, pick a vibe. IslandCut edits the whole trailer.</span>
          </button>
          <button className="home-card" onClick={pickAndImport}>
            <Icon name="scissors" size={28} />
            <b>Edit it myself</b>
            <span>Import your clips and put them on the timeline yourself.</span>
          </button>
          <button className="home-card" onClick={() => setUI({ dialog: 'newProject' })}>
            <Icon name="layers" size={28} />
            <b>Use a template</b>
            <span>Ready-made 15s, 30s and 60s trailer layouts to fill in.</span>
          </button>
          <button className="home-card" onClick={() => openProject()}>
            <Icon name="folder" size={28} />
            <b>Open a project</b>
            <span>Continue a trailer you saved before.</span>
          </button>
        </div>
        {recent.length > 0 && (
          <div className="home-recent">
            <div className="hint" style={{ marginBottom: 6 }}>Recent projects</div>
            {recent.slice(0, 5).map((r) => (
              <button key={r} className="ghost home-recent-item" onClick={() => openProject(r)} title={r}>
                <Icon name="file" size={14} /> {r.split(/[\\/]/).pop()!.replace(/(\.islandcut|\.uts)?\.json$/i, '')}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
