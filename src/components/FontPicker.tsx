// Font picker with live previews: the fonts that ship with IslandCut (grouped by style) first,
// then fonts loaded into the project, then the fonts installed on this PC.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getState, setRT, useStore } from '../store/store';
import { Icon } from './Icon';

interface Props {
  value: string;
  onChange: (family: string) => void;
  /** extra families (e.g. fonts loaded into the project) */
  extra?: string[];
  sample?: string;
}

export function FontPicker({ value, onChange, extra = [], sample }: Props): React.ReactElement {
  const bundled = useStore((s) => s.rt.bundledFonts);
  const system = useStore((s) => s.rt.fonts);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, w: 260, up: false });

  useEffect(() => {
    if (open && !getState().rt.fonts.length) window.api.listFonts().then((f) => setRT({ fonts: f }));
  }, [open]);

  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const match = (f: string) => !ql || f.toLowerCase().includes(ql);
    const out: { name: string; fonts: string[] }[] = [];
    const cats = new Map<string, string[]>();
    for (const f of bundled) {
      if (!match(f.family)) continue;
      if (!cats.has(f.category)) cats.set(f.category, []);
      cats.get(f.category)!.push(f.family);
    }
    for (const [name, fonts] of cats) out.push({ name: `IslandCut · ${name}`, fonts });
    const ex = extra.filter(match);
    if (ex.length) out.push({ name: 'Project fonts', fonts: ex });
    const bset = new Set(bundled.map((b) => b.family));
    const sys = system.filter((f) => !bset.has(f) && match(f));
    if (sys.length) out.push({ name: 'Installed on this PC', fonts: sys });
    return out;
  }, [bundled, system, extra, q]);

  const toggle = () => {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      const up = r.bottom + 380 > window.innerHeight;
      setPos({ x: Math.min(r.left, window.innerWidth - 300), y: up ? r.top : r.bottom, w: Math.max(260, r.width), up });
    }
    setOpen(!open);
    setQ('');
  };

  return (
    <>
      <button ref={btn} className="font-picker-btn" onClick={toggle} style={{ fontFamily: `"${value}", sans-serif` }} title="Choose a font">
        <span className="grow">{value}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open &&
        createPortal(
          <div className="font-picker-backdrop" onMouseDown={() => setOpen(false)}>
            <div
              className="font-picker"
              style={{ left: pos.x, width: pos.w + 40, ...(pos.up ? { bottom: window.innerHeight - pos.y + 4 } : { top: pos.y + 4 }) }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input autoFocus placeholder={`Search ${bundled.length + system.length} fonts`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false); }} />
              <div className="font-picker-list">
                {groups.map((g) => (
                  <div key={g.name}>
                    <div className="font-picker-cat">{g.name}</div>
                    {g.fonts.map((f) => (
                      <button
                        key={g.name + f}
                        className={'font-picker-item' + (f === value ? ' on' : '')}
                        onClick={() => {
                          onChange(f);
                          setOpen(false);
                        }}
                      >
                        <span style={{ fontFamily: `"${f}", sans-serif` }}>{sample || f}</span>
                        {sample && <span className="hint">{f}</span>}
                      </button>
                    ))}
                  </div>
                ))}
                {!groups.length && <div className="hint" style={{ padding: 10 }}>No font matches “{q}”.</div>}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
