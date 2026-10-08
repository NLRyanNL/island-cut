// Boo dancing + a rotating trailer tip, shown whenever IslandCut is busy (export, Auto Trailer…).
import React, { useEffect, useState } from 'react';
import { Mascot } from './Hints';

export const TRAILER_TIPS = [
  'Put your best shot in the first 3 seconds. Viewers decide fast.',
  'Cut on the beat: hard cuts on drum hits feel twice as punchy.',
  "Keep shots short in action parts (under 1 second) and let calm shots breathe.",
  'End with your island code big and clear, held for at least 3 seconds.',
  'Epic does not allow active gunfire in island trailers. Show the action around it instead.',
  'Cinematic trailers must not show the HUD. Record with the UI hidden for the cleanest shots.',
  'A riser into a boom on your title reveal makes it hit much harder.',
  'Slow motion right before the drop builds tension. Speed back up on the beat.',
  'Show what makes your island different in the first 10 seconds.',
  'Use one strong font family for all titles. Mixing many looks messy.',
  'Vertical 9:16 versions do great on TikTok and Shorts. Export both!',
  'Turn the game sound down under the music, but keep big hits and explosions.',
  'A short fade to black between parts gives the viewer a breath.',
  'Text on screen: 3–5 words, on screen long enough to read twice.',
  'Record extra footage. Picking from more clips gives a better trailer.',
  'Use the same color look on every shot so the trailer feels like one film.',
  'Camera movement makes shots feel alive: slow pans, push-ins and drone flyovers.',
  'Check your trailer with the sound off. It should still make sense.',
  'Music you do not own the rights to can get your trailer flagged.',
  'Shorter is often better: a tight 30 seconds beats a slow 60.',
  'Right-click a clip on the timeline for slow-mo, freeze frames and transitions.',
  'Press C to cut at the playhead, Shift+Delete to remove a clip and close the gap.',
  'Hold Alt while dragging to place a clip without snapping.',
  'Your project autosaves a recovery copy every 30 seconds.',
];

/** A rotating tip; changes every few seconds with a fade. */
export function RotatingTip({ every = 6500 }: { every?: number }): React.ReactElement {
  const [i, setI] = useState(() => Math.floor(Math.random() * TRAILER_TIPS.length));
  const [show, setShow] = useState(true);
  useEffect(() => {
    const id = setInterval(() => {
      setShow(false);
      setTimeout(() => {
        setI((x) => (x + 1) % TRAILER_TIPS.length);
        setShow(true);
      }, 300);
    }, every);
    return () => clearInterval(id);
  }, [every]);
  return (
    <div className={'boo-tip' + (show ? ' show' : '')}>
      <span className="boo-tip-label">Boo's tip</span>
      {TRAILER_TIPS[i]}
    </div>
  );
}

export function DancingBoo({ size = 96 }: { size?: number }): React.ReactElement {
  return (
    <div className="boo-dance" style={{ width: size, height: size * 1.15 }}>
      <span className="boo-note n1">♪</span>
      <span className="boo-note n2">♫</span>
      <div className="boo-body">
        <Mascot size={size} />
      </div>
      <div className="boo-shadow" />
    </div>
  );
}

export function BooBusy(props: { title: string; sub?: string; progress?: number; eta?: number; small?: boolean }): React.ReactElement {
  const pct = props.progress === undefined ? undefined : Math.round(Math.max(0, Math.min(1, props.progress)) * 100);
  return (
    <div className={'boo-busy' + (props.small ? ' small' : '')}>
      <DancingBoo size={props.small ? 64 : 96} />
      <div className="boo-busy-main">
        <div className="boo-busy-title">{props.title}</div>
        {props.sub && <div className="hint">{props.sub}</div>}
        {pct !== undefined && (
          <>
            <div className="progress-bar" style={{ margin: '10px 0 4px' }}>
              <div style={{ width: `${pct}%` }} />
            </div>
            <div className="hint">
              {pct}%{props.eta !== undefined && props.eta > 0 ? ` · about ${formatEta(props.eta)} left` : ''}
            </div>
          </>
        )}
        <RotatingTip />
      </div>
    </div>
  );
}

function formatEta(s: number): string {
  if (s < 60) return `${Math.ceil(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}
