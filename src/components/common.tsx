import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { dismissToast, useStore } from '../store/store';

export function Toasts(): React.ReactElement {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }): React.ReactElement {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [props.onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={'modal' + (props.wide ? ' wide' : '')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="grow">{props.title}</span>
          <button className="ghost icon" onClick={props.onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

/**
 * Number slider + numeric box. Calls onChange continuously while dragging (onCommit at the end),
 * so the store can coalesce a drag into one undo step.
 */
export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onStart?: () => void;
  onCommit?: () => void;
  format?: (v: number) => string;
  width?: number;
}): React.ReactElement {
  const { value, min, max, step = 0.01 } = props;
  const [text, setText] = useState<string | null>(null);
  const dragging = useRef(false);
  const shown = props.format ? props.format(value) : String(Math.round(value / step) * step).slice(0, 7);
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={() => {
          dragging.current = true;
          props.onStart?.();
        }}
        onPointerUp={() => {
          if (dragging.current) props.onCommit?.();
          dragging.current = false;
        }}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={() => {
          /* handled by parent reset buttons */
        }}
      />
      <input
        type="text"
        style={{ width: props.width ?? 58, textAlign: 'right' }}
        value={text ?? shown}
        onFocus={() => setText(shown)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = parseFloat(text ?? '');
          if (isFinite(n)) {
            props.onStart?.();
            props.onChange(Math.min(max, Math.max(min, n)));
            props.onCommit?.();
          }
          setText(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
    </>
  );
}

export function Field(props: { label: string; children: React.ReactNode; extra?: React.ReactNode; title?: string }): React.ReactElement {
  return (
    <div className="row" title={props.title}>
      <label>{props.label}</label>
      <div className="ctrl">{props.children}</div>
      <div>{props.extra}</div>
    </div>
  );
}

export function fmtBytes(n: number): string {
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(0) + ' MB';
  return (n / 1e3).toFixed(0) + ' KB';
}
