// Beginner help: first-launch tour, dismissable tips and a context-aware tip line.
import React, { useEffect, useLayoutEffect, useState } from 'react';
import { Icon } from './Icon';
import { getState, setUI, useStore } from '../store/store';
import { projectDuration } from '../../shared/timelineOps';
import mascotUrl from '../assets/mascot.png';
import mascotSmallUrl from '../assets/mascot-small.png';

/** Boo, the IslandCut ghost: the app's mascot and tutorial buddy. */
export const MASCOT_NAME = 'Boo';

export function Mascot({ size = 64, float, className }: { size?: number; float?: boolean; className?: string }): React.ReactElement {
  return <img src={size <= 48 ? mascotSmallUrl : mascotUrl} width={size} height={size} alt={MASCOT_NAME} draggable={false} className={'mascot' + (float ? ' float' : '') + (className ? ` ${className}` : '')} />;
}

const LS_HINTS = 'islandcut.hints';
const LS_DISMISSED = 'islandcut.dismissedTips';
const LS_TOUR = 'islandcut.tour.v2'; // v2: Boo's tour (shows once more after updating)

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

export function hintsEnabled(): boolean {
  return lsGet(LS_HINTS) !== 'off';
}

export function setHintsEnabled(on: boolean): void {
  lsSet(LS_HINTS, on ? 'on' : 'off');
  setUI({ showHints: on });
}

const dismissed = new Set<string>(JSON.parse(lsGet(LS_DISMISSED) ?? '[]') as string[]);

/** Small inline tip with a bulb icon. Hidden when hints are off or after the user dismisses it. */
export function Tip({ id, children, compact }: { id: string; children: React.ReactNode; compact?: boolean }): React.ReactElement | null {
  const show = useStore((s) => s.ui.showHints);
  const [hidden, setHidden] = useState(dismissed.has(id));
  if (!show || hidden) return null;
  return (
    <div className={'tip' + (compact ? ' compact' : '')}>
      <Mascot size={26} />
      <div className="tip-text">{children}</div>
      <button
        className="ghost icon tip-x"
        title="Hide this tip"
        onClick={() => {
          dismissed.add(id);
          lsSet(LS_DISMISSED, JSON.stringify([...dismissed]));
          setHidden(true);
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/** One line of advice for what to do next, based on the current state. */
export function ContextTip(): React.ReactElement | null {
  const show = useStore((s) => s.ui.showHints);
  const tip = useStore((s) => {
    const p = s.project;
    const nMedia = Object.keys(p.media).length;
    const nClips = Object.keys(p.clips).length;
    const sel = s.ui.selection.map((id) => p.clips[id]).filter(Boolean);
    if (!nMedia) return 'Start by importing your gameplay clips and music (top-left, or just drag files into the window).';
    if (!nClips) return 'Drag a clip from the Media Bin onto the V1 track below. Music goes on A2.';
    if (sel.length === 1) {
      const c = sel[0];
      if (c.kind === 'audio') return 'Drag the yellow line to change volume, the white corner dots to fade. Right-click for beat detection and export.';
      if (c.kind === 'text') return 'Edit the words, font and animation in the panel on the right.';
      return 'Press C to cut at the red playhead, Delete to remove. Right-click the clip for transitions, slow-mo, freeze frame and more.';
    }
    if (sel.length > 1) return `${sel.length} clips selected — drag to move them together, Delete to remove.`;
    if (projectDuration(p) > 5) return 'Press Space to play. Click a clip to edit it. When it looks good, hit Export (top-right).';
    return 'Click a clip to select it. Drag its edges to trim.';
  });
  if (!show) return null;
  return (
    <div className="context-tip" title={tip}>
      <Mascot size={18} />
      <span>{tip}</span>
    </div>
  );
}

interface TourStep {
  sel: string;
  title: string;
  text: string;
  side: 'right' | 'left' | 'top' | 'bottom';
}

const STEPS: TourStep[] = [
  { sel: '', title: `Hi, I'm ${MASCOT_NAME}!`, text: "I'll show you around IslandCut in 30 seconds. You'll be making Fortnite trailers in no time. Ready?", side: 'bottom' },
  { sel: '[data-tour="bin"]', title: '1 · Media Bin', text: 'Import your gameplay recordings, music, sound effects and images here. Drag files straight in from Explorer.', side: 'right' },
  { sel: '[data-tour="timeline"]', title: '2 · Timeline', text: 'Drag clips here to build your trailer. Video goes on V tracks, music and sounds on A tracks, titles on T.', side: 'top' },
  { sel: '[data-tour="preview"]', title: '3 · Preview', text: 'Press Space to play. Use the arrow keys to step one frame at a time.', side: 'bottom' },
  { sel: '[data-tour="inspector"]', title: '4 · Inspector', text: 'Click a clip to tweak it here: size and position, speed and slow-mo, color looks, transitions, volume and text.', side: 'left' },
  { sel: '[data-tour="auto"]', title: '5 · Auto Trailer', text: 'Short on time? Auto Trailer finds your best moments, skips gunfire, hides the HUD for cinematic trailers and builds a full edit for you.', side: 'bottom' },
  { sel: '[data-tour="export"]', title: '6 · Export', text: 'Done? Export an MP4 for YouTube, TikTok or your Fortnite island page. You can queue several versions.', side: 'bottom' },
  { sel: '', title: "That's it!", text: "I'll leave little tips around the app. Want me to make your first trailer? Click Auto Trailer. You can replay this tour from the ? menu.", side: 'bottom' },
];

export function shouldShowTour(): boolean {
  return lsGet(LS_TOUR) !== 'done' && !window.api?.selftest && !window.api?.testMode;
}

export function Tour({ onClose }: { onClose: () => void }): React.ReactElement | null {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[i];
  useLayoutEffect(() => {
    if (!step.sel) {
      setRect(new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0));
      return;
    }
    const el = document.querySelector(step.sel);
    setRect(el ? el.getBoundingClientRect() : null);
    const onResize = () => setRect(document.querySelector(step.sel)?.getBoundingClientRect() ?? null);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [i]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });
  const finish = () => {
    lsSet(LS_TOUR, 'done');
    onClose();
  };
  const next = () => (i < STEPS.length - 1 ? setI(i + 1) : finish());
  if (!rect) return null;
  const pad = 6;
  const box = { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  const cardW = 380;
  let cx = 0;
  let cy = 0;
  const centered = !step.sel;
  if (centered) {
    cx = window.innerWidth / 2 - cardW / 2;
    cy = window.innerHeight / 2 - 110;
  } else if (step.side === 'right') {
    cx = box.left + box.width + 14;
    cy = box.top + 20;
  } else if (step.side === 'left') {
    cx = box.left - cardW - 14;
    cy = box.top + 20;
  } else if (step.side === 'top') {
    cx = box.left + box.width / 2 - cardW / 2;
    cy = box.top - 170;
  } else {
    cx = Math.min(window.innerWidth - cardW - 12, box.left + box.width / 2 - cardW / 2);
    cy = box.top + box.height + 14;
  }
  cx = Math.max(12, Math.min(window.innerWidth - cardW - 12, cx));
  cy = Math.max(12, Math.min(window.innerHeight - 190, cy));
  return (
    <div className="tour">
      <div className={'tour-spot' + (centered ? ' none' : '')} style={box} />
      <div className={'tour-card' + (centered ? ' centered' : '')} style={{ left: cx, top: cy, width: cardW }}>
        <div className="tour-buddy">
          <Mascot size={centered ? 84 : 54} float />
          <div>
            <div className="tour-title">{step.title}</div>
            <div className="tour-text">{step.text}</div>
          </div>
        </div>
        <div className="tour-foot">
          <div className="tour-dots">
            {STEPS.map((_, k) => (
              <span key={k} className={k === i ? 'on' : ''} />
            ))}
          </div>
          <button className="ghost small" onClick={finish}>
            Skip
          </button>
          {i > 0 && (
            <button className="small" onClick={() => setI(i - 1)}>
              Back
            </button>
          )}
          <button className="primary small" onClick={next}>
            {i === 0 ? "Let's go" : i === STEPS.length - 1 ? 'Start editing' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function resetTour(): void {
  lsSet(LS_TOUR, '');
}

export { getState };
