// Logo Maker: make a transparent PNG logo from text (with game-style presets) or by removing the
// background of an existing image. The result is saved as a PNG and added to the Media bin.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../common';
import { Icon } from '../Icon';
import { FontPicker } from '../FontPicker';
import { getState, setUI, toast } from '../../store/store';
import { importFiles } from '../../store/actions';
import { ensureFont } from '../../fonts/bundled';
import {
  DEFAULT_LOGO,
  LOGO_PRESETS,
  TextLogoStyle,
  canvasFromImageData,
  canvasToPng,
  hasTransparency,
  removeBackground,
  renderTextLogo,
  trimCanvas,
} from './logoRender';

interface Request {
  text?: string;
  imagePath?: string;
  /** start in "remove background" mode (asks for an image when none is given) */
  removeBg?: boolean;
  onDone?: (mediaId: string) => void;
  /** dialog to go back to when finished (the Auto Trailer opens the maker from its Branding step) */
  returnTo?: 'autoTrailer' | null;
}
let request: Request = {};
let lastStyle: TextLogoStyle | null = null;

/** Open the Logo Maker. `onDone` gets the id of the imported PNG. */
export function openLogoMaker(r: Request = {}): void {
  request = { returnTo: r.onDone ? 'autoTrailer' : null, ...r };
  setUI({ dialog: 'logoMaker' });
}

/** "Remove background": opens the cut-out tool on an image (asks for one when none is given). */
export async function openRemoveBackground(imagePath?: string, onDone?: (mediaId: string) => void): Promise<void> {
  let file = imagePath;
  if (!file) {
    const r = await window.api.openFiles({ title: 'Choose an image to remove its background', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (!r.length) return;
    file = r[0];
  }
  openLogoMaker({ imagePath: file, removeBg: true, onDone, returnTo: null });
}

function Color({ value, onChange, title }: { value: string; onChange: (v: string) => void; title?: string }): React.ReactElement {
  return <input type="color" value={value} title={title} onChange={(e) => onChange(e.target.value)} style={{ width: 34, height: 26, padding: 0, border: '1px solid #2a2a32', borderRadius: 6, background: 'none' }} />;
}

function Range(props: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; fmt?: (v: number) => string }): React.ReactElement {
  return (
    <>
      <label>{props.label}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} style={{ flex: 1 }} />
        <span className="hint mono" style={{ width: 44, textAlign: 'right' }}>{props.fmt ? props.fmt(props.value) : props.value}</span>
      </div>
    </>
  );
}

export function LogoMaker(): React.ReactElement {
  const [mode, setMode] = useState<'text' | 'image'>(request.imagePath ? 'image' : 'text');
  const [st, setSt] = useState<TextLogoStyle>(() => ({
    ...(lastStyle ?? DEFAULT_LOGO),
    line1: request.text || lastStyle?.line1 || getState().project.name.toUpperCase().slice(0, 24) || DEFAULT_LOGO.line1,
  }));
  const [fontTick, setFontTick] = useState(0);
  const [imgPath, setImgPath] = useState<string | null>(request.imagePath ?? null);
  const [srcData, setSrcData] = useState<ImageData | null>(null);
  const [alreadyClear, setAlreadyClear] = useState(false);
  const [bgColor, setBgColor] = useState<[number, number, number] | null>(null);
  const [tolerance, setTolerance] = useState(25);
  const [feather, setFeather] = useState(30);
  const [connected, setConnected] = useState(true);
  const [checker, setChecker] = useState<'dark' | 'light' | 'check'>('check');
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const set = (p: Partial<TextLogoStyle>) => setSt((s) => ({ ...s, ...p }));

  // fonts load asynchronously: redraw once the chosen font is ready
  useEffect(() => {
    let alive = true;
    ensureFont(st.font, st.weight).then(() => alive && setFontTick((t) => t + 1));
    return () => {
      alive = false;
    };
  }, [st.font, st.weight]);

  // load the source image
  useEffect(() => {
    if (!imgPath) return;
    let alive = true;
    (async () => {
      try {
        const bytes = await window.api.readBytes(imgPath);
        const bmp = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer]));
        const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(bmp.width * k));
        cv.height = Math.max(1, Math.round(bmp.height * k));
        const ctx = cv.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
        const data = ctx.getImageData(0, 0, cv.width, cv.height);
        if (!alive) return;
        setSrcData(data);
        setAlreadyClear(hasTransparency(data));
        setBgColor(null);
      } catch (e) {
        toast(`Could not open the image: ${(e as Error).message}`, 'error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [imgPath]);

  const result = useMemo<HTMLCanvasElement | null>(() => {
    void fontTick;
    if (mode === 'text') return st.line1.trim() || st.line2.trim() ? renderTextLogo(st) : null;
    if (!srcData) return null;
    const img = alreadyClear && !bgColor ? srcData : removeBackground(srcData, { color: bgColor, tolerance, feather, connected });
    return trimCanvas(canvasFromImageData(img), 6);
  }, [mode, st, fontTick, srcData, alreadyClear, bgColor, tolerance, feather, connected]);

  useEffect(() => {
    const host = previewRef.current;
    if (!host) return;
    host.innerHTML = '';
    if (result) {
      result.style.maxWidth = '100%';
      result.style.maxHeight = '100%';
      result.style.objectFit = 'contain';
      if (mode === 'image') {
        result.style.cursor = 'crosshair';
        result.title = 'Click a colour to remove it';
        result.onclick = (e) => {
          if (!srcData) return;
          // map the click back to the (untrimmed) source and take that colour
          const r = result.getBoundingClientRect();
          const x = Math.floor(((e.clientX - r.left) / r.width) * result.width);
          const y = Math.floor(((e.clientY - r.top) / r.height) * result.height);
          const px = result.getContext('2d')!.getImageData(x, y, 1, 1).data;
          if (px[3] < 10) return;
          setBgColor([px[0], px[1], px[2]]);
        };
      }
      host.appendChild(result);
    }
  }, [result]);

  const pickImage = async () => {
    const r = await window.api.openFiles({ title: 'Choose an image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
    if (r.length) {
      setImgPath(r[0]);
      setMode('image');
    }
  };

  const save = async () => {
    if (!result) return;
    setSaving(true);
    try {
      const base = (mode === 'text' ? st.line1 || 'logo' : (imgPath ?? 'logo').split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '')).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40) || 'logo';
      const out = await window.api.saveFile({ title: mode === 'image' ? 'Save the cut-out (transparent PNG)' : 'Save logo (transparent PNG)', defaultPath: `${base}_${mode === 'image' ? 'nobg' : 'logo'}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
      if (!out) return;
      const file = /\.png$/i.test(out) ? out : `${out}.png`;
      if (file !== out) {
        // the Save dialog only asked about the name without ".png": ask before replacing an existing file
        await window.api.allowPaths([file]);
        const [exists] = await window.api.exists([file]);
        if (exists) {
          const r = await window.api.confirm({ message: `${file.split(/[\\/]/).pop()} already exists.`, detail: 'Replace it?', buttons: ['Replace', 'Cancel'], cancelId: 1 });
          if (r === 1) return;
        }
      }
      await window.api.writeUserFile(file, await canvasToPng(result));
      lastStyle = st;
      const [m] = await importFiles([file]);
      toast(mode === 'image' ? 'Background removed. The transparent PNG is in your media.' : 'Logo saved and added to your media', 'success');
      const cb = request.onDone;
      const back = request.returnTo ?? null;
      request = {};
      if (m && cb) cb(m.id); // before switching back, so the Auto Trailer window sees the new logo
      setUI({ dialog: back });
    } catch (e) {
      toast(`Saving failed: ${(e as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    const back = request.returnTo ?? null;
    request = {};
    setUI({ dialog: back });
  };

  return (
    <Modal
      title={mode === 'image' ? 'Remove background' : 'Logo Maker'}
      wide
      onClose={close}
      footer={
        <>
          <span className="grow hint">{result ? `${result.width}×${result.height} px · transparent PNG` : ''}</span>
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={!result || saving} onClick={save}>
            <Icon name="export" size={14} /> {saving ? 'Saving…' : mode === 'image' ? 'Save transparent PNG' : 'Save logo'}
          </button>
        </>
      }
    >
      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
          <Icon name="text" size={13} /> Make a text logo
        </button>
        <button className={mode === 'image' ? 'on' : ''} onClick={() => (imgPath ? setMode('image') : pickImage())}>
          <Icon name="image" size={13} /> Remove an image's background
        </button>
      </div>
      <div className="logo-maker">
        <div className="logo-controls">
          {mode === 'text' ? (
            <>
              <div className="chips" style={{ marginBottom: 10 }}>
                {LOGO_PRESETS.map((p) => (
                  <button key={p.id} onClick={() => set(p.style)} title={`Style: ${p.label}`}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="form-grid">
                <label>Name</label>
                <input type="text" value={st.line1} onChange={(e) => set({ line1: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                <label>Second line</label>
                <input type="text" value={st.line2} placeholder="optional, e.g. ZONE WARS" onChange={(e) => set({ line2: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                <label>Font</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <FontPicker value={st.font} onChange={(f) => set({ font: f })} sample={st.line1.slice(0, 16) || undefined} />
                  <select value={st.weight} onChange={(e) => set({ weight: Number(e.target.value) })} style={{ width: 70 }}>
                    {[400, 700, 800, 900].map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </div>
                <label>Fill</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Color value={st.fill1} onChange={(v) => set({ fill1: v })} title="Top colour" />
                  {st.gradient && <Color value={st.fill2} onChange={(v) => set({ fill2: v })} title="Bottom colour" />}
                  <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input type="checkbox" checked={st.gradient} onChange={(e) => set({ gradient: e.target.checked })} /> gradient
                  </label>
                  <label style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 8 }}>
                    <input type="checkbox" checked={st.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} /> CAPS
                  </label>
                </div>
                <label>Outline</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Color value={st.outline} onChange={(v) => set({ outline: v })} />
                  <input type="range" min={0} max={24} value={st.outlineWidth} onChange={(e) => set({ outlineWidth: Number(e.target.value) })} style={{ flex: 1 }} />
                </div>
                <label>Outer border</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Color value={st.outer} onChange={(v) => set({ outer: v })} />
                  <input type="range" min={0} max={30} value={st.outerWidth} onChange={(e) => set({ outerWidth: Number(e.target.value) })} style={{ flex: 1 }} />
                </div>
                <label>3D depth</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Color value={st.depthColor} onChange={(v) => set({ depthColor: v })} />
                  <input type="range" min={0} max={30} value={st.depth} onChange={(e) => set({ depth: Number(e.target.value) })} style={{ flex: 1 }} />
                </div>
                <label>Glow / shadow</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Color value={st.glow} onChange={(v) => set({ glow: v })} />
                  <input type="range" min={0} max={60} value={st.glowSize} onChange={(e) => set({ glowSize: Number(e.target.value) })} style={{ flex: 1 }} />
                </div>
                <Range label="Spacing" value={st.letterSpacing} min={-0.05} max={0.4} step={0.01} onChange={(v) => set({ letterSpacing: v })} fmt={(v) => v.toFixed(2)} />
                <Range label="Tilt" value={st.tilt} min={-15} max={15} onChange={(v) => set({ tilt: v })} fmt={(v) => `${v}°`} />
                {st.line2 && <Range label="Line 2 size" value={st.line2Scale} min={0.2} max={1} step={0.02} onChange={(v) => set({ line2Scale: v })} fmt={(v) => `${Math.round(v * 100)}%`} />}
              </div>
            </>
          ) : (
            <div className="form-grid">
              <div className="callout" style={{ margin: '0 0 4px', gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <Icon name="cutout" size={16} />
                <span>Makes the background see-through. Works best on images with a plain background (a logo or character on white, black or one colour). Click the preview to pick the colour to remove.</span>
              </div>
              <label>Image</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {imgPath ? imgPath.split(/[\\/]/).pop() : 'none'}
                </span>
                <button className="small" onClick={pickImage}>
                  Choose…
                </button>
              </div>
              {alreadyClear && !bgColor ? (
                <>
                  <label />
                  <div className="hint" style={{ color: 'var(--ok, #3ccf8e)' }}>
                    This image already has a transparent background. You can save it as it is, or click a colour in the preview to remove more.
                  </div>
                </>
              ) : (
                <>
                  <label>Background</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {bgColor ? (
                      <span style={{ width: 22, height: 22, borderRadius: 5, border: '1px solid #444', background: `rgb(${bgColor.join(',')})` }} />
                    ) : (
                      <span className="hint">detected automatically</span>
                    )}
                    <span className="hint">· click the preview to pick a colour</span>
                    {bgColor && (
                      <button className="small" onClick={() => setBgColor(null)}>
                        Auto
                      </button>
                    )}
                  </div>
                  <Range label="Tolerance" value={tolerance} min={0} max={100} onChange={setTolerance} />
                  <Range label="Soft edge" value={feather} min={0} max={100} onChange={setFeather} />
                  <label>Mode</label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={connected} onChange={(e) => setConnected(e.target.checked)} />
                    Only the outside (keeps matching colours inside the logo)
                  </label>
                </>
              )}
            </div>
          )}
        </div>
        <div className="logo-preview-wrap">
          <div className={`logo-preview bg-${checker}`}>
            {/* the canvas is inserted by hand into this host; React never renders children into it */}
            <div className="logo-canvas-host" ref={previewRef} />
            {!result && <span className="hint">{mode === 'text' ? 'Type a name' : 'Choose an image (PNG or JPG)'}</span>}
          </div>
          <div className="chips" style={{ justifyContent: 'center', marginTop: 6 }}>
            {(['check', 'dark', 'light'] as const).map((c) => (
              <button key={c} className={checker === c ? 'on' : ''} onClick={() => setChecker(c)}>
                {c === 'check' ? 'Transparent' : c === 'dark' ? 'On dark' : 'On light'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
