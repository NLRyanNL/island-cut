import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem =
  | { label: string; onClick: () => void; shortcut?: string; disabled?: boolean }
  | { sep: true }
  | { header: string };

let setMenuState: ((m: { x: number; y: number; items: MenuItem[] } | null) => void) | null = null;

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]): void {
  e.preventDefault?.();
  setMenuState?.({ x: e.clientX, y: e.clientY, items });
}

export function ContextMenuHost(): React.ReactElement | null {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    setMenuState = setM;
    return () => {
      setMenuState = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 6), y: Math.min(m.y, window.innerHeight - r.height - 6) });
  }, [m]);
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      setM(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setM(null);
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', esc, true);
    const onBlur = () => setM(null);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [m]);
  if (!m) return null;
  return (
    <div className="ctxmenu" ref={ref} style={{ left: pos.x || m.x, top: pos.y || m.y }} onContextMenu={(e) => e.preventDefault()}>
      {m.items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="sep" />;
        if ('header' in it) return <div key={i} className="label">{it.header}</div>;
        return (
          <div
            key={i}
            className={'mi' + (it.disabled ? ' disabled' : '')}
            onClick={() => {
              setM(null);
              it.onClick();
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <span className="k">{it.shortcut}</span>}
          </div>
        );
      })}
    </div>
  );
}
