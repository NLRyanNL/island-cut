import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { Mascot } from '../Hints';
import { BooBusy } from '../BooBusy';
import { Modal } from '../common';
import { getState, loadProjectState, setState, setUI, toast, useStore } from '../../store/store';
import { confirmDiscard, detectBeatsFor, ensureMediaRuntime, importFiles, updateTitle } from '../../store/actions';
import { clampMusicStart, skipIntroOffset } from '../../../shared/music';
import { openLogoMaker } from '../logo/LogoMaker';
import { hasTransparency } from '../logo/logoRender';
import type { AspectId, MediaItem, TransitionType, WaveformData } from '../../../shared/types';
import type { FootageAnalysis } from '../../../shared/analysis';
import {
  AI_FRAME_SYSTEM,
  AI_SYSTEM,
  applyAiConcept,
  applyAiFrameReview,
  buildConcept,
  buildTrailerProject,
  conceptPrompt,
  parseStyle,
  pickShots,
  BuildOptions,
  TrailerConcept,
  TrailerMode,
} from '../../../shared/autotrailer';
import { shortDuration } from '../../../shared/time';
import { AUDIO_EXTS } from '../../../shared/defaults';
import { TRANSITIONS as ALL_TRANSITIONS, transitionLabel } from '../../../shared/transitions';


// The setup survives closing the window (and a trip to the Logo Maker).
const persisted: Record<string, unknown> = {};
function usePersisted<T>(key: string, init: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const [v, setV] = useState<T>(() => (key in persisted ? (persisted[key] as T) : typeof init === 'function' ? (init as () => T)() : init));
  const set = (nv: T | ((prev: T) => T)) =>
    setV((prev) => {
      const val = typeof nv === 'function' ? (nv as (p: T) => T)(prev) : nv;
      persisted[key] = val;
      return val;
    });
  return [v, set];
}

/** Length in seconds mentioned in a style text ("45s", "1 min", "90 seconds"), if any. */
function lengthInText(t: string): number | null {
  const sec = /(\d{1,3}(?:\.\d)?)\s*(?:s|sec|secs|second|seconds)\b/i.exec(t);
  if (sec) return Number(sec[1]);
  const min = /(\d(?:\.\d)?)\s*(?:m|min|mins|minute|minutes)\b/i.exec(t);
  return min ? Number(min[1]) * 60 : null;
}

const NO_MUSIC = 'none';
const MIN_LEN = 8;
const MAX_LEN = 180;

const TRANSITIONS: (TransitionType | 'none')[] = ['none', ...ALL_TRANSITIONS.map((t) => t.id)];

// keep the last concept while the app is open (re-opening the dialog keeps your edits)
let lastConcept: TrailerConcept | null = null;
let lastAnalyses: Record<string, FootageAnalysis> = {};
let lastBeats: number[] = [];

export function AutoTrailerDialog(): React.ReactElement {
  const media = useStore((s) => s.project.media);
  const settings = useStore((s) => s.rt.settings);
  const projAspect = useStore((s) => s.project.settings.aspect);
  const videos = Object.values(media).filter((m) => m.kind === 'video' && !m.missing);
  // songs only: sound effects (incl. the built-in ones) are never offered as trailer music
  const audios = Object.values(media).filter((m) => m.kind === 'audio' && !m.missing && m.folder !== 'sfx').sort((a, b) => (b.folder === 'music' ? 1 : 0) - (a.folder === 'music' ? 1 : 0) || b.duration - a.duration);
  // a plan made for another project (its clips are gone) is thrown away
  if (lastConcept && lastConcept.shots.some((sh) => { const c = lastConcept!.candidates.find((x) => x.id === sh.candidateId); return !c || !media[c.mediaId]; })) lastConcept = null;
  const [step, setStep] = useState<'setup' | 'working' | 'concept'>(lastConcept ? 'concept' : 'setup');
  const [mode, setMode] = usePersisted<TrailerMode>('mode', 'gameplay');
  const [selected, setSelected] = usePersisted<Set<string>>('selected', () => new Set(videos.map((v) => v.id)));
  const [musicId, setMusicId] = usePersisted<string>('music', audios[0]?.id ?? '');
  const [duration, setDuration] = usePersisted('duration', 30);
  const [lenText, setLenText] = useState(String(duration));
  const [aspect, setAspect] = usePersisted<AspectId>('aspect', projAspect);
  const [styleText, setStyleText] = usePersisted('style', '');
  const [title, setTitle] = usePersisted('title', '');
  const [code, setCode] = usePersisted('code', '');
  const [useAi, setUseAi] = usePersisted('ai', !!settings?.hasApiKey);
  const [logoId, setLogoId] = usePersisted<string>('logo', '');
  const [thumbId, setThumbId] = usePersisted<string>('thumb', '');
  const [musicStart, setMusicStart] = usePersisted('musicStart', 0);
  const [wiz, setWiz] = usePersisted('wizardStep', 0);
  const [autoSfx, setAutoSfx] = usePersisted('autoSfx', true);
  const [dragOver, setDragOver] = useState(false);
  const images = Object.values(media).filter((m) => m.kind === 'image' && !m.missing);
  const setLength = (v: number) => {
    const d = Math.round(Math.min(MAX_LEN, Math.max(MIN_LEN, v)));
    setDuration(d);
    setLenText(String(d));
  };
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [concept, setConcept] = useState<TrailerConcept | null>(lastConcept);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    // newly imported clips are selected automatically
    setSelected((s) => {
      const n = new Set(s);
      for (const v of videos) if (!n.has(v.id) && !seenIds.has(v.id)) n.add(v.id);
      videos.forEach((v) => seenIds.add(v.id));
      return n;
    });
  }, [videos.length]);
  useEffect(() => {
    // pick a song automatically unless the user chose "No music"; forget songs that are gone
    if (musicId === NO_MUSIC) return;
    if (!musicId || !media[musicId] || media[musicId].folder === 'sfx') setMusicId(audios[0]?.id ?? '');
  }, [audios.length]);
  useEffect(() => {
    // drop selections that point at media no longer in this project
    setSelected((sel) => new Set([...sel].filter((id) => media[id])));
    if (logoId && !media[logoId]) setLogoId('');
    if (thumbId && !media[thumbId]) setThumbId('');
  }, [Object.keys(media).length]);

  const totalFootage = videos.filter((v) => selected.has(v.id)).reduce((a, v) => a + v.duration, 0);
  const say = (line: string) => setLog((l) => [...l, line]);

  const run = async () => {
    const chosen = videos.filter((v) => selected.has(v.id));
    if (!chosen.length) {
      toast('Select at least one video clip (or import your gameplay first).', 'error');
      return;
    }
    setStep('working');
    setLog([]);
    setProgress(0.02);
    const music0 = musicId && musicId !== NO_MUSIC ? getState().project.media[musicId] : undefined;
    const totalWork = chosen.length * 3 + (music0 ? 1 : 0) + (useAi && settings?.hasApiKey ? 3 : 0) + 1;
    let doneWork = 0;
    const tick = (n = 1) => {
      doneWork += n;
      setProgress(Math.min(0.98, doneWork / totalWork));
    };
    try {
      // the mood comes from the style description only (a title like "Haunted Party" must not make it horror)
      const text = [styleText, code].filter(Boolean).join(', ');
      const style = parseStyle(text, { mode, duration, aspect });
      style.mode = mode; // the toggle wins
      style.duration = duration; // and so does the Length field
      if (title) style.title = title;
      if (code) style.islandCode = code;
      if (!/vertical|9:16|tiktok|shorts|reels|square|1:1/i.test(styleText)) style.aspect = aspect;
      const analyses: Record<string, FootageAnalysis> = {};
      for (const m of chosen) {
        say(`Watching ${m.name} (${shortDuration(m.duration)})…`);
        analyses[m.id] = await window.api.analyzeMedia(m);
        tick(3);
        const a = analyses[m.id];
        const gun = a.gunfire.filter((g) => g > 0.35).length;
        say(`   done: ${a.hudBoxes.length ? 'HUD found' : 'no HUD'} · ${gun ? `${gun}s of gunfire skipped` : 'no gunfire'}`);
      }
      let beats: number[] = [];
      const music = musicId && musicId !== NO_MUSIC ? getState().project.media[musicId] : undefined;
      if (music) {
        say(`Finding the beat in ${music.name}…`);
        const b = await window.api.detectBeats(music.path);
        beats = b.beats;
        tick();
        say(`   done: ${b.bpm} BPM`);
      }
      say('Picking the best shots and planning the edit…');
      let c = buildConcept(
        style,
        chosen.map((m) => ({ media: m, analysis: analyses[m.id] })),
        music?.id,
      );
      tick();
      say(`   done: ${c.shots.length} shots in ${c.sections.length} parts`);
      if (useAi && settings?.hasApiKey) {
        try {
          say('Claude is checking frames for HUD and gunfire…');
          const top = [...c.candidates].filter((x) => x.quality > -0.5).sort((a, b) => Math.max(b.action, b.calm) + b.quality - (Math.max(a.action, a.calm) + a.quality)).slice(0, 20);
          const imgs: string[] = [];
          const ids: string[] = [];
          for (const cand of top) {
            const m = getState().project.media[cand.mediaId];
            const fr = await window.api.sampleFrames(m.path, [cand.srcIn + cand.length / 2], 384);
            if (fr[0]) {
              imgs.push(fr[0].jpegBase64);
              ids.push(cand.id);
            }
          }
          const review = await window.api.aiComplete({ system: AI_FRAME_SYSTEM, prompt: `There are ${imgs.length} frames, numbered 0..${imgs.length - 1} in order.`, images: imgs, maxTokens: 3000 });
          applyAiFrameReview(c.candidates, ids, review);
          tick(2);
          say('   done: frame review');
          say('Claude is writing the trailer concept…');
          const answer = await window.api.aiComplete({ system: AI_SYSTEM, prompt: conceptPrompt([text || 'a great trailer', title ? `title "${title}"` : ''].filter(Boolean).join(', '), style, c.candidates), maxTokens: 4000 });
          c = applyAiConcept(c, answer);
          tick();
          say('   done: concept written by Claude');
        } catch (e) {
          say(`   warning: AI step failed, using the built-in planner: ${(e as Error).message}`);
        }
      }
      c.logoMediaId = logoId || undefined;
      c.thumbnailMediaId = thumbId || undefined;
      c.musicStart = music ? clampMusicStart(musicStart, music.duration, style.duration) : 0;
      lastAnalyses = analyses;
      lastBeats = beats;
      lastConcept = c;
      setConcept(c);
      setStep('concept');
    } catch (e) {
      say(`error: ${(e as Error).message}`);
      toast(`Auto Trailer failed: ${(e as Error).message}`, 'error');
    }
  };

  // thumbnails for picked shots
  useEffect(() => {
    if (!concept) return;
    let cancelled = false;
    (async () => {
      for (const s of concept.shots) {
        if (cancelled) return;
        if (thumbs[s.candidateId]) continue;
        const c = concept.candidates.find((x) => x.id === s.candidateId);
        const m = c ? getState().project.media[c.mediaId] : undefined;
        if (!c || !m) continue;
        const fr = await window.api.sampleFrames(m.path, [c.srcIn + Math.min(1, c.length / 2)], 192);
        if (fr[0] && !cancelled) setThumbs((t) => ({ ...t, [s.candidateId]: `data:image/jpeg;base64,${fr[0].jpegBase64}` }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [concept?.shots.map((s) => s.candidateId).join(',')]);

  const update = (fn: (c: TrailerConcept) => TrailerConcept) => {
    if (!concept) return;
    const n = fn(structuredClone(concept));
    lastConcept = n;
    setConcept(n);
  };

  const repick = () =>
    update((c) => {
      c.shots = pickShots(c.sections, c.candidates);
      return c;
    });

  const swapShot = (idx: number) =>
    update((c) => {
      const shot = c.shots[idx];
      const sec = c.sections.find((s) => s.id === shot.sectionId)!;
      const usedIds = new Set(c.shots.map((s) => s.candidateId));
      const alt = c.candidates
        .filter((x) => !usedIds.has(x.id) && x.gunfire <= 0.35 && !c.shots.some((s) => { const o = c.candidates.find((y) => y.id === s.candidateId); return o && o.mediaId === x.mediaId && Math.abs(o.srcIn - x.srcIn) < 2; }))
        .sort((a, b) => sec.energy * b.action + (1 - sec.energy) * b.calm + b.quality - (sec.energy * a.action + (1 - sec.energy) * a.calm + a.quality))[0];
      if (alt) c.shots[idx] = { ...shot, candidateId: alt.id };
      return c;
    });

  const build = async () => {
    if (!concept) return;
    if (!(await confirmDiscard())) return;
    const base = getState().project;
    const fps = base.settings.fps;
    // built-in sound effects (generated once, copyright-free) go into the project like any other sound
    let sfx: BuildOptions['sfx'];
    const hadMedia = new Set(Object.keys(base.media));
    if (autoSfx) {
      try {
        const list = await window.api.builtinSfx();
        await importFiles(list.map((x) => x.path), 'sfx');
        const byPath = new Map(Object.values(getState().project.media).map((m) => [m.path, m.id]));
        sfx = Object.fromEntries(list.map((x) => [x.id, byPath.get(x.path)]).filter(([, v]) => v));
      } catch (e) {
        toast(`Sound effects skipped: ${(e as Error).message}`, 'error');
      }
    }
    const base2 = getState().project;
    const live = base2.media;
    const proj = buildTrailerProject(
      base2,
      { ...concept, logoMediaId: logoId && live[logoId] ? logoId : undefined, thumbnailMediaId: thumbId && live[thumbId] ? thumbId : undefined },
      { fps, beats: lastBeats, analyses: lastAnalyses, sfx },
    );
    // keep the Media bin tidy: only the built-in sounds the trailer actually uses stay in it
    const used = new Set(Object.values(proj.clips).map((c) => c.mediaId));
    for (const id of Object.values(sfx ?? {})) if (id && !used.has(id) && !hadMedia.has(id)) delete proj.media[id];
    loadProjectState(proj, null);
    persisted.wizardStep = 0; // next time the wizard starts at the beginning
    setState({ dirty: true }); // a generated trailer is a new, unsaved project
    updateTitle();
    for (const m of Object.values(proj.media)) ensureMediaRuntime(m);
    setUI({ dialog: null, playhead: 0 });
    setTimeout(() => document.querySelector<HTMLButtonElement>('button[title^="Zoom to fit"]')?.click(), 100);
    toast('Trailer built! Everything is editable: move, trim or swap shots, edit the titles, then Export.', 'success', 8000);
  };

  // ------------------------------------------------------------------ render
  if (step === 'working') {
    // main lines become checklist rows; indented "done/warning" lines are their results
    const rows: { text: string; result?: string; bad?: boolean }[] = [];
    for (const l of log) {
      if (/^\s+/.test(l) && rows.length) {
        rows[rows.length - 1].result = l.trim().replace(/^done:\s*/, '');
        rows[rows.length - 1].bad = /^\s*(warning|error)/.test(l);
      } else rows.push({ text: l });
    }
    const failed = log.some((l) => l.startsWith('error'));
    return (
      <Modal title="Auto Trailer" wide onClose={() => setUI({ dialog: null })} footer={failed ? <button onClick={() => setStep('setup')}><Icon name="chevronLeft" size={14} /> Back to setup</button> : undefined}>
        {failed ? (
          <div className="wizard-buddy" style={{ marginBottom: 14 }}>
            <Mascot size={72} />
            <div>
              <h2 className="wizard-title">Oops, something went wrong</h2>
              <div className="wizard-sub" style={{ marginBottom: 0 }}>See the message below. Go back to change your setup and try again.</div>
            </div>
          </div>
        ) : (
          <BooBusy title="Boo is making your trailer…" sub="Watching your footage, finding the beat and planning the edit. Usually under a minute." progress={progress} />
        )}
        <div className="work-list">
          {rows.map((r, i) => {
            const current = i === rows.length - 1 && !r.result && !failed;
            return (
              <div key={i} className={'work-row' + (current ? ' current' : '') + (r.bad ? ' bad' : '')}>
                <span className="wr-icon">{current ? <span className="spinner" /> : <Icon name={r.bad ? 'warning' : 'check'} size={13} />}</span>
                <span className="grow">{r.text.replace(/…$/, '')}</span>
                {r.result && <span className="hint">{r.result}</span>}
              </div>
            );
          })}
        </div>
      </Modal>
    );
  }

  if (step === 'concept' && concept) {
    const candById = new Map(concept.candidates.map((c) => [c.id, c]));
    const total = concept.sections.reduce((a, s) => a + s.duration, 0);
    return (
      <Modal
        title="Auto Trailer"
        wide
        onClose={() => setUI({ dialog: null })}
        footer={
          <>
            <button
              onClick={() => {
                lastConcept = null;
                setConcept(null);
                setStep('setup');
              }}
            >
              <Icon name="chevronLeft" size={14} /> Change setup
            </button>
            <span className="grow hint">
              {concept.source === 'ai' ? 'Written by Claude' : 'Built-in planner'} · {concept.shots.filter((s) => s.include).length} shots · {total.toFixed(1)}s
            </span>
            <button onClick={repick} title="Pick the best shots again for the current sections">
              <Icon name="reset" size={14} /> Re-pick shots
            </button>
            <button className="primary big" onClick={build}>
              <Icon name="sparkle" size={15} /> Build my trailer
            </button>
          </>
        }
      >
        <div className="wizard-buddy">
          <Mascot size={56} />
          <h2 className="wizard-title" style={{ margin: 0 }}>Here's my plan for your trailer</h2>
        </div>
        <div className="wizard-sub">Your trailer, part by part. Change anything you like (or nothing), then click <b>Build my trailer</b>. Everything stays editable on the timeline afterwards.</div>
        <div className="concept-strip">
          {concept.sections.map((sec) => (
            <div key={sec.id} className={'cs-block' + (sec.endCard ? ' end' : '')} style={{ flex: Math.max(0.6, sec.duration) }} title={`${sec.name}: ${sec.duration.toFixed(1)}s`}>
              <div className="cs-energy" style={{ height: `${Math.round(15 + sec.energy * 85)}%` }} />
              <b>{sec.name}</b>
              <span>{sec.duration.toFixed(1)}s</span>
            </div>
          ))}
        </div>
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <label>Title</label>
          <input type="text" value={concept.title} onChange={(e) =>
              update((c) => {
                // the title card follows the new title (so the logo reveal / riser still find it)
                const prev = (c.style.title || c.title).trim().toUpperCase();
                const next = e.target.value;
                const sections = c.sections.map((sec) => (sec.text && prev && sec.text.text.trim().toUpperCase() === prev ? { ...sec, text: { ...sec.text, text: next.toUpperCase() } } : sec));
                return { ...c, title: next, style: { ...c.style, title: next }, sections };
              })
            } onKeyDown={(e) => e.stopPropagation()} />
          <label>Idea</label>
          <input type="text" value={concept.logline} onChange={(e) => update((c) => ({ ...c, logline: e.target.value }))} onKeyDown={(e) => e.stopPropagation()} />
          <label>Island code</label>
          <input type="text" value={concept.style.islandCode} placeholder="1234-5678-9012" onChange={(e) => update((c) => ({ ...c, style: { ...c.style, islandCode: e.target.value } }))} onKeyDown={(e) => e.stopPropagation()} />
          <label>Style</label>
          <div className="chips">
            <span className="chip-static">{concept.style.mode === 'cinematic' ? 'Cinematic (no UI)' : 'Gameplay'}</span>
            <span className="chip-static">mood: {concept.style.mood}</span>
            <span className="chip-static">look: {concept.style.look}</span>
            <span className="chip-static">{concept.style.aspect}</span>
            {concept.style.letterbox && <span className="chip-static">letterbox</span>}
            <span className="chip-static">{logoId ? 'logo ✓' : 'no logo'}</span>
            <span className="chip-static">{thumbId ? 'thumbnail ✓' : 'no thumbnail'}</span>
          </div>
        </div>
        {concept.notes.map((n) => (
          <div key={n} style={{ color: 'var(--warn)', marginBottom: 4, fontSize: 12.5, display: 'flex', gap: 6 }}>
            <Icon name="warning" size={14} /> {n}
          </div>
        ))}
        {concept.sections.map((s, si) => (
          <div key={s.id} className="list" style={{ marginTop: 10, padding: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                value={s.name}
                style={{ width: 170, fontWeight: 600 }}
                onChange={(e) => update((c) => ((c.sections[si].name = e.target.value), c))}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <span className="hint">length</span>
              <input type="number" step={0.5} min={1} value={+s.duration.toFixed(2)} style={{ width: 64 }} onChange={(e) => update((c) => ((c.sections[si].duration = Math.max(0.5, Number(e.target.value))), c))} />
              <span className="hint">s · cut every</span>
              <input type="number" step={0.1} min={0.4} value={+s.shotLength.toFixed(2)} style={{ width: 58 }} onChange={(e) => update((c) => ((c.sections[si].shotLength = Math.max(0.3, Number(e.target.value))), c))} />
              <span className="hint">s · energy</span>
              <input type="range" min={0} max={1} step={0.05} value={s.energy} style={{ width: 80 }} onChange={(e) => update((c) => ((c.sections[si].energy = Number(e.target.value)), c))} />
              <span className="hint">transition</span>
              <select value={s.transition ?? 'none'} onChange={(e) => update((c) => ((c.sections[si].transition = e.target.value === 'none' ? null : (e.target.value as TransitionType)), c))}>
                {TRANSITIONS.map((t) => (
                  <option key={t} value={t}>
                    {t === 'none' ? 'Cut' : transitionLabel(t)}
                  </option>
                ))}
              </select>
              {s.speed < 1 && <span className="chip-static">slow-mo {s.speed}×</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <span className="hint" style={{ width: 40 }}>
                Text
              </span>
              <input
                type="text"
                value={s.text?.text ?? ''}
                placeholder="(no text)"
                style={{ flex: 1 }}
                onChange={(e) => update((c) => ((c.sections[si].text = e.target.value ? { text: e.target.value, sub: c.sections[si].text?.sub, preset: c.sections[si].text?.preset ?? 'fadeUp' } : undefined), c))}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, overflowX: 'auto', paddingBottom: 4 }}>
              {concept.shots.map((shot, idx) => {
                if (shot.sectionId !== s.id) return null;
                const c = candById.get(shot.candidateId);
                if (!c) return null;
                return (
                  <div key={idx} className="shot-card" style={{ opacity: shot.include ? 1 : 0.4 }}>
                    <div className="shot-thumb" style={thumbs[shot.candidateId] ? { backgroundImage: `url(${thumbs[shot.candidateId]})` } : undefined} />
                    <div className="hint" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.aiNote ?? ''}>
                      {c.mediaName} @{c.srcIn}s
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', minHeight: 16 }}>
                      {c.flags.map((f) => (
                        <span key={f} className="flag">
                          {f}
                        </span>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11 }}>
                        <input type="checkbox" checked={shot.include} onChange={(e) => update((cc) => ((cc.shots[idx].include = e.target.checked), cc))} /> use
                      </label>
                      <button className="small" onClick={() => swapShot(idx)} title="Swap for the next best shot">
                        <Icon name="swap" size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {!concept.shots.some((x) => x.sectionId === s.id) && <span className="hint">{s.endCard ? 'End card uses a calm background shot.' : 'No shots — not enough footage. Import more clips and start over.'}</span>}
            </div>
          </div>
        ))}
      </Modal>
    );
  }

  // ------------------------------------------------------------------ setup (wizard)
  const chosenVideos = videos.filter((v) => selected.has(v.id));
  const stepOk = [true, chosenVideos.length > 0, true, true, true];
  const goNext = () => (wiz < WIZARD.length - 1 ? setWiz(wiz + 1) : run());
  const onDropFiles = async (files: FileList) => {
    const paths = Array.from(files).map((f) => window.api.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    // on the Music step dropped audio files are songs; videos/images keep their normal folder
    const isAudio = (p: string) => AUDIO_EXTS.includes(p.split('.').pop()?.toLowerCase() ?? '');
    const added = wiz === 2 ? [...(await importFiles(paths.filter(isAudio), 'music')), ...(await importFiles(paths.filter((p) => !isAudio(p))))] : await importFiles(paths);
    const vids = added.filter((m) => m.kind === 'video');
    const auds = added.filter((m) => m.kind === 'audio');
    const imgs = added.filter((m) => m.kind === 'image');
    if (vids.length) setSelected((sel) => new Set([...sel, ...vids.map((v) => v.id)]));
    if (auds.length) {
      setMusicId(auds[0].id);
      setMusicStart(0);
    }
    if (imgs.length && wiz === 4) {
      if (!logoId) setLogoId(imgs[0].id);
      else if (!thumbId) setThumbId(imgs[0].id);
    }
    const parts = [vids.length && `${vids.length} clip${vids.length > 1 ? 's' : ''}`, auds.length && `${auds.length} song${auds.length > 1 ? 's' : ''}`, imgs.length && `${imgs.length} image${imgs.length > 1 ? 's' : ''}`].filter(Boolean);
    if (parts.length) toast(`Added ${parts.join(', ')}`, 'success', 1800);
  };
  return (
    <Modal
      title="Auto Trailer"
      wide
      onClose={() => setUI({ dialog: null })}
      footer={
        <>
          {wiz > 0 ? (
            <button onClick={() => setWiz(wiz - 1)}>
              <Icon name="chevronLeft" size={14} /> Back
            </button>
          ) : (
            <button onClick={() => setUI({ dialog: null })}>Cancel</button>
          )}
          <span className="grow hint" style={{ textAlign: 'center' }}>
            Step {wiz + 1} of {WIZARD.length}
            {chosenVideos.length > 0 && ` · ${chosenVideos.length} clip${chosenVideos.length === 1 ? '' : 's'} (${shortDuration(totalFootage)})`}
            {` · ${duration}s trailer`}
          </span>
          {wiz < WIZARD.length - 1 && wiz >= 2 && (
            <button onClick={run} disabled={!chosenVideos.length} title="Skip the optional steps and create the trailer now">
              Create now
            </button>
          )}
          <button className="primary big" onClick={goNext} disabled={!stepOk[wiz]}>
            {wiz === WIZARD.length - 1 ? (
              <>
                <Icon name="sparkle" size={15} /> Create my trailer
              </>
            ) : (
              <>
                Next <Icon name="chevronRight" size={14} />
              </>
            )}
          </button>
        </>
      }
    >
      <div
        className={'wizard' + (dragOver ? ' drag-over' : '')}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void onDropFiles(e.dataTransfer.files);
        }}
      >
        <div className="wizard-steps">
          {WIZARD.map((w, i) => (
            <button key={w.title} className={'wizard-step' + (i === wiz ? ' on' : i < wiz ? ' done' : '')} onClick={() => (i <= wiz || stepOk.slice(0, i).every(Boolean) ? setWiz(i) : undefined)}>
              <span className="num">{i < wiz ? <Icon name="check" size={12} /> : i + 1}</span>
              <span className="lbl">{w.title}</span>
            </button>
          ))}
        </div>
        <h2 className="wizard-title">{WIZARD[wiz].question}</h2>
        <div className="wizard-sub">{WIZARD[wiz].help}</div>

        {wiz === 0 && (
          <>
            <div className="mode-cards">
              <div className={'mode-card' + (mode === 'gameplay' ? ' on' : '')} onClick={() => setMode('gameplay')}>
                <div className="mc-icon">
                  <Icon name="gamepad" size={26} />
                </div>
                <div className="mc-title">Gameplay trailer</div>
                <div className="hint">Shows how your island plays. In-game UI (HUD) is allowed. Fast and fun.</div>
              </div>
              <div className={'mode-card' + (mode === 'cinematic' ? ' on' : '')} onClick={() => setMode('cinematic')}>
                <div className="mc-icon">
                  <Icon name="clapper" size={26} />
                </div>
                <div className="mc-title">Cinematic trailer</div>
                <div className="hint">Movie-style. No UI allowed: IslandCut hides the HUD for you and adds letterbox, slow-mo and a film look.</div>
              </div>
            </div>
            <div className="wizard-label">Where will you post it?</div>
            <div className="choice-row">
              {(['16:9', '9:16', '1:1'] as AspectId[]).map((a) => (
                <button key={a} className={'choice' + (aspect === a ? ' on' : '')} onClick={() => setAspect(a)}>
                  <span className={`aspect-icon a${a.replace(':', 'x')}`} />
                  <b>{a === '16:9' ? 'Fortnite / YouTube' : a === '9:16' ? 'TikTok / Shorts / Reels' : 'Instagram square'}</b>
                  <span className="hint">{a === '16:9' ? 'Wide 16:9' : a === '9:16' ? 'Vertical 9:16' : 'Square 1:1'}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {wiz === 1 && (
          <>
            <DropZone icon="film" text="Drop your gameplay recordings here" sub="Lots of short clips or one long recording both work" button="Choose video files" onPick={async () => {
              const r = await window.api.openFiles({ title: 'Choose your gameplay recordings', multi: true, filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }] });
              if (r.length) {
                const added = await importFiles(r);
                setSelected((sel) => new Set([...sel, ...added.filter((m) => m.kind === 'video').map((m) => m.id)]));
              }
            }} />
            {videos.length > 0 && (
              <div className="clip-grid">
                {videos.map((v) => (
                  <ClipTile key={v.id} m={v} on={selected.has(v.id)} onToggle={() => setSelected((sel) => { const n = new Set(sel); if (n.has(v.id)) n.delete(v.id); else n.add(v.id); return n; })} />
                ))}
              </div>
            )}
            {videos.length > 0 && totalFootage < duration * 1.5 && (
              <div className="callout warn">
                <Icon name="warning" size={14} /> You have {shortDuration(totalFootage)} of footage for a {duration}s trailer. More footage gives better shots; some clips may be reused.
              </div>
            )}
          </>
        )}

        {wiz === 2 && (
          <MusicStep audios={audios} musicId={musicId} setMusicId={setMusicId} musicStart={musicStart} setMusicStart={setMusicStart} trailerLen={duration} />
        )}

        {wiz === 3 && (
          <>
            <div className="wizard-label">How long?</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="choice-row compact">
                {[15, 30, 45, 60, 90, 120].map((d) => (
                  <button key={d} className={'choice' + (duration === d ? ' on' : '')} onClick={() => setLength(d)}>
                    <b>{d < 60 ? `${d} sec` : `${d / 60 === Math.round(d / 60) ? d / 60 : (d / 60).toFixed(1)} min`}</b>
                  </button>
                ))}
              </div>
              <span className="hint">or exactly</span>
              <input
                type="number"
                min={MIN_LEN}
                max={MAX_LEN}
                value={lenText}
                style={{ width: 70 }}
                onChange={(e) => {
                  setLenText(e.target.value);
                  const v = Number(e.target.value);
                  if (v >= MIN_LEN && v <= MAX_LEN) setDuration(Math.round(v));
                }}
                onBlur={() => setLength(Number(lenText) || duration)}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <span className="hint">seconds</span>
            </div>
            <div className="wizard-label">Pick a vibe</div>
            <div className="style-grid">
              {STYLE_CARDS.map((c) => (
                <button key={c.id} className={'style-card' + (styleText === c.text ? ' on' : '')} onClick={() => setStyleText(c.text)}>
                  <Icon name={c.icon} size={22} />
                  <b>{c.label}</b>
                  <span>{c.desc}</span>
                </button>
              ))}
            </div>
            <div className="wizard-label">
              Or describe it in your own words <span className="hint">(optional)</span>
            </div>
            <textarea
              rows={2}
              style={{ width: '100%' }}
              placeholder='e.g. "slow creepy build, then fast cuts on the beat, big title reveal, end with coming soon"'
              value={styleText}
              onChange={(e) => {
                setStyleText(e.target.value);
                const len = lengthInText(e.target.value);
                if (len && len >= MIN_LEN && len <= MAX_LEN) setLength(len);
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <label className="ai-row">
              <input type="checkbox" checked={autoSfx} onChange={(e) => setAutoSfx(e.target.checked)} />
              <span>
                Add sound effects <span className="hint">(whooshes on transitions, a riser and boom on the title reveal; built in and free to use)</span>
              </span>
            </label>
            <label className="ai-row" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={useAi && !!settings?.hasApiKey} disabled={!settings?.hasApiKey} onChange={(e) => setUseAi(e.target.checked)} />
              <span>
                Let Claude AI write the plan and double-check frames for HUD / gunfire
                {!settings?.hasApiKey && (
                  <span className="hint">
                    {' '}
                    (optional, needs an API key in{' '}
                    <a href="#" onClick={(e) => (e.preventDefault(), setUI({ dialog: 'settings' }))}>
                      Settings
                    </a>
                    ; works great without it)
                  </span>
                )}
              </span>
            </label>
          </>
        )}

        {wiz === 4 && (
          <div className="form-grid roomy">
            <label>Island name</label>
            <input type="text" value={title} placeholder="e.g. KILLER CLOWN" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <label>Island code</label>
            <input type="text" value={code} placeholder="1234-5678-9012 (shown on the end card)" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <label>Logo</label>
            <LogoPicker images={images} value={logoId} onChange={setLogoId} title={title} />
            <label>Thumbnail</label>
            <ThumbnailPicker images={images} value={thumbId} onChange={setThumbId} />
          </div>
        )}

        {dragOver && (
          <div className="drop-overlay">
            <Icon name="import" size={30} />
            Drop to add {wiz === 2 ? 'your music' : wiz === 4 ? 'your logo / thumbnail' : 'your files'}
          </div>
        )}
      </div>
    </Modal>
  );
}

const WIZARD = [
  { title: 'Type', question: 'What kind of trailer?', help: 'UEFN islands use both: a gameplay trailer, and a cinematic trailer without any in-game UI.' },
  { title: 'Clips', question: 'Add your gameplay', help: 'IslandCut watches every second and picks the best moments. Shots with gunfire are skipped automatically (not allowed by Epic).' },
  { title: 'Music', question: 'Pick your music', help: 'Upload your own song. Cuts land on the beat. Use music you have the rights to.' },
  { title: 'Style', question: 'How should it feel?', help: 'Pick a length and a vibe. You can change everything afterwards.' },
  { title: 'Branding', question: 'Name, logo & thumbnail', help: 'All optional. The logo becomes the big title reveal, and the thumbnail goes behind the end card.' },
];

const STYLE_CARDS: { id: string; label: string; desc: string; text: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'hype', label: 'Hype', desc: 'Fast cuts, punchy transitions', text: 'hype trailer, fast cuts on the beat, show the best moments, end with PLAY NOW', icon: 'bolt' },
  { id: 'epic', label: 'Epic', desc: 'Big build-up and title reveal', text: 'epic cinematic trailer with slow motion, a big title reveal and a dramatic ending', icon: 'clapper' },
  { id: 'horror', label: 'Horror', desc: 'Slow creepy build, then chaos', text: 'horror trailer, slow creepy build, then fast cuts on the beat, big title reveal, coming soon', icon: 'eye' },
  { id: 'fun', label: 'Fun', desc: 'Colorful and bouncy', text: 'fun colorful trailer, bouncy cuts, show the coolest features, end with PLAY NOW', icon: 'sparkle' },
  { id: 'mystery', label: 'Mystery', desc: 'Dark, tense, secretive', text: 'mysterious trailer, tension, slow reveals, glitchy cuts, coming soon', icon: 'search' },
  { id: 'chill', label: 'Chill', desc: 'Calm, smooth and relaxed', text: 'chill relaxing trailer, smooth crossfades, calm shots of the island', icon: 'snow' },
];

function DropZone(props: { icon: Parameters<typeof Icon>[0]['name']; text: string; sub: string; button: string; onPick: () => void }): React.ReactElement {
  return (
    <div className="drop-zone" onClick={props.onPick}>
      <Icon name={props.icon} size={28} />
      <b>{props.text}</b>
      <span className="hint">{props.sub}</span>
      <button className="primary" onClick={(e) => (e.stopPropagation(), props.onPick())}>
        <Icon name="import" size={14} /> {props.button}
      </button>
    </div>
  );
}

function ClipTile({ m, on, onToggle }: { m: MediaItem; on: boolean; onToggle: () => void }): React.ReactElement {
  const thumb = useStore((s) => s.rt.thumbs[m.id]);
  return (
    <button className={'clip-tile' + (on ? ' on' : '')} onClick={onToggle} title={on ? 'Click to leave this clip out' : 'Click to use this clip'}>
      <span className="ct-thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
        <span className="ct-check">{on && <Icon name="check" size={12} />}</span>
        <span className="ct-dur">{shortDuration(m.duration)}</span>
      </span>
      <span className="ct-name">{m.name}</span>
    </button>
  );
}

function fmtTime(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

function MusicStep(props: { audios: MediaItem[]; musicId: string; setMusicId: (id: string) => void; musicStart: number; setMusicStart: (t: number) => void; trailerLen: number }): React.ReactElement {
  const { audios, musicId, setMusicId, musicStart, setMusicStart, trailerLen } = props;
  const m = useStore((s) => (musicId ? s.project.media[musicId] : undefined));
  const [wave, setWave] = useState<WaveformData | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setWave(null);
    if (!m) return;
    let alive = true;
    window.api.waveform(m.path).then((w) => alive && setWave(w));
    if (!m.bpm) void detectBeatsFor(m.id).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [m?.id]);
  // stop the preview when leaving the step / switching songs
  useEffect(() => () => audio.current?.pause(), []);
  useEffect(() => {
    audio.current?.pause();
    setPlaying(false);
  }, [m?.id]);

  const songLen = m?.duration ?? 0;
  const used = Math.min(trailerLen, Math.max(0, songLen - musicStart));
  // draw the waveform with the part the trailer uses highlighted
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !m) return;
    const W = cv.clientWidth * devicePixelRatio;
    const H = cv.clientHeight * devicePixelRatio;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    const x = (t: number) => (t / Math.max(0.01, songLen)) * W;
    ctx.fillStyle = 'rgba(90,124,255,0.16)';
    ctx.fillRect(x(musicStart), 0, x(musicStart + used) - x(musicStart), H);
    if (wave) {
      const bars = Math.floor(W / (3 * devicePixelRatio));
      for (let i = 0; i < bars; i++) {
        const t = (i / bars) * songLen;
        const k = Math.floor(t * wave.peaksPerSec);
        let v = 0;
        for (let j = k; j < Math.min(wave.peaks.length, k + Math.ceil(wave.peaksPerSec * (songLen / bars))); j++) v = Math.max(v, wave.peaks[j]);
        const inside = t >= musicStart && t <= musicStart + used;
        ctx.fillStyle = inside ? '#7f9bff' : '#3a3a44';
        const h = Math.max(2, v * H * 0.9);
        ctx.fillRect((i / bars) * W, (H - h) / 2, 2 * devicePixelRatio, h);
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x(musicStart), 0, 2 * devicePixelRatio, H);
    if (playing) {
      ctx.fillStyle = '#ff3b4d';
      ctx.fillRect(x(pos), 0, 2 * devicePixelRatio, H);
    }
  }, [wave, musicStart, used, songLen, pos, playing, m?.id]);

  const play = (from: number) => {
    if (!m) return;
    if (!audio.current) {
      audio.current = new Audio();
      audio.current.ontimeupdate = () => setPos(audio.current!.currentTime);
      audio.current.onended = () => setPlaying(false);
    }
    const a = audio.current;
    if (a.src !== window.api.mediaUrl(m.path)) a.src = window.api.mediaUrl(m.path);
    a.currentTime = from;
    void a.play();
    setPlaying(true);
  };
  const stop = () => {
    audio.current?.pause();
    setPlaying(false);
  };

  const upload = async () => {
    const r = await window.api.openFiles({ title: 'Choose your music', filters: [{ name: 'Music', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }] });
    if (!r.length) return;
    const added = await importFiles(r, 'music');
    const a = added.find((x) => x.kind === 'audio');
    if (a) {
      setMusicId(a.id);
      setMusicStart(0);
    }
  };

  return (
    <>
      {audios.length === 0 ? (
        <DropZone icon="music" text="Drop your song here" sub="mp3, wav, ogg, m4a or flac" button="Upload music" onPick={upload} />
      ) : (
        <>
          <div className="music-list">
            {audios.map((a) => (
              <div key={a.id} className={'music-row' + (musicId === a.id ? ' on' : '')} onClick={() => (musicId !== a.id ? (setMusicId(a.id), setMusicStart(0)) : undefined)}>
                <span className="radio">{musicId === a.id && <span />}</span>
                <Icon name="music" size={16} />
                <span className="grow">{a.name}</span>
                <span className="hint">
                  {fmtTime(a.duration)}
                  {a.bpm ? ` · ${a.bpm} BPM` : ''}
                </span>
              </div>
            ))}
            <div className={'music-row' + (!m ? ' on' : '')} onClick={() => setMusicId(NO_MUSIC)}>
              <span className="radio">{!m && <span />}</span>
              <Icon name="mute" size={16} />
              <span className="grow">No music</span>
              <span className="hint">use the game sound only</span>
            </div>
          </div>
          <button style={{ marginTop: 8 }} onClick={upload}>
            <Icon name="import" size={14} /> Upload another song
          </button>
        </>
      )}
      {m && (
        <div className="music-trim">
          <div className="wizard-label" style={{ marginTop: 0 }}>
            Which part of the song? <span className="hint">The blue part plays in your trailer. Click the waveform to move it.</span>
          </div>
          <canvas
            ref={canvas}
            className="music-wave"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const t = ((e.clientX - r.left) / r.width) * songLen;
              setMusicStart(clampMusicStart(t, songLen, trailerLen));
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
            <button className={playing ? '' : 'primary'} onClick={() => (playing ? stop() : play(musicStart))}>
              <Icon name={playing ? 'pause' : 'play'} size={14} /> {playing ? 'Stop' : 'Listen'}
            </button>
            <span>
              Starts at <b>{fmtTime(musicStart)}</b>
            </span>
            <input type="range" min={0} max={Math.max(0, songLen - Math.min(trailerLen, songLen))} step={0.1} value={musicStart} onChange={(e) => setMusicStart(Number(e.target.value))} style={{ flex: 1, minWidth: 140 }} />
            <button
              onClick={() => wave && setMusicStart(clampMusicStart(skipIntroOffset(wave.peaks, wave.peaksPerSec), songLen, trailerLen))}
              disabled={!wave}
              title="Jump past a quiet intro to where the song gets going"
            >
              <Icon name="bolt" size={14} /> Skip quiet intro
            </button>
            {musicStart > 0 && <button onClick={() => setMusicStart(0)}>From the start</button>}
          </div>
          {songLen < trailerLen && <div className="callout warn"><Icon name="warning" size={14} /> This song ({fmtTime(songLen)}) is shorter than your trailer. The last part will have no music.</div>}
          {m.bpm ? <div className="hint" style={{ marginTop: 6 }}>{m.bpm} BPM: cuts will land on the beat.</div> : <div className="hint" style={{ marginTop: 6 }}>Finding the beat…</div>}
        </div>
      )}
    </>
  );
}

const seenIds = new Set<string>();

async function importImage(title: string): Promise<MediaItem | null> {
  const r = await window.api.openFiles({ title, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (!r.length) return null;
  const [m] = await importFiles(r);
  return m ?? null;
}

/** null = checking, true/false = has transparency */
function useTransparency(m: MediaItem | undefined): boolean | null {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    setV(null);
    if (!m) return;
    let alive = true;
    (async () => {
      try {
        const bytes = await window.api.readBytes(m.path);
        const bmp = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer]));
        const k = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(bmp.width * k));
        cv.height = Math.max(1, Math.round(bmp.height * k));
        const ctx = cv.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
        if (alive) setV(hasTransparency(ctx.getImageData(0, 0, cv.width, cv.height)));
      } catch {
        if (alive) setV(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [m?.id]);
  return v;
}

function ImageChoice({ images, value, onChange, none }: { images: MediaItem[]; value: string; onChange: (id: string) => void; none: string }): React.ReactElement {
  const thumb = useStore((s) => (value ? s.rt.thumbs[value] : undefined));
  return (
    <>
      {value && <span className="img-chip" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined} />}
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 220 }}>
        <option value="">{none}</option>
        {images.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.width}×{m.height})
          </option>
        ))}
      </select>
    </>
  );
}

function LogoPicker({ images, value, onChange, title }: { images: MediaItem[]; value: string; onChange: (id: string) => void; title: string }): React.ReactElement {
  const m = useStore((s) => (value ? s.project.media[value] : undefined));
  const clear = useTransparency(m);
  const make = (imagePath?: string) =>
    openLogoMaker({
      text: title || undefined,
      imagePath,
      onDone: (id) => {
        persisted.logo = id;
        onChange(id);
      },
    });
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <ImageChoice images={images} value={value} onChange={onChange} none="No logo (title text instead)" />
        <button className="small" onClick={async () => { const n = await importImage('Choose your logo (transparent PNG)'); if (n) onChange(n.id); }}>
          Upload…
        </button>
        <button className="small primary" onClick={() => make()}>
          <Icon name="sparkle" size={12} /> Make a logo
        </button>
      </div>
      {m && clear === false && (
        <div className="hint" style={{ color: 'var(--warn)', marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icon name="warning" size={13} /> This logo has a solid background.
          <button className="small" onClick={() => make(m.path)}>
            Remove background
          </button>
        </div>
      )}
      {m && clear && <div className="hint" style={{ marginTop: 4 }}>Transparent PNG, used for the title reveal and the end card.</div>}
      {!m && <div className="hint" style={{ marginTop: 4 }}>A transparent PNG of your island's name. No logo? Click “Make a logo”.</div>}
    </div>
  );
}

function ThumbnailPicker({ images, value, onChange }: { images: MediaItem[]; value: string; onChange: (id: string) => void }): React.ReactElement {
  const m = useStore((s) => (value ? s.project.media[value] : undefined));
  const ratioOk = m ? Math.abs(m.width / Math.max(1, m.height) - 16 / 9) < 0.02 : true;
  const sizeOk = m ? m.width >= 1920 && m.height >= 1080 : true;
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <ImageChoice images={images} value={value} onChange={onChange} none="No thumbnail" />
        <button className="small" onClick={async () => { const n = await importImage('Choose your island thumbnail (1920×1080)'); if (n) onChange(n.id); }}>
          Upload…
        </button>
      </div>
      {m && (!ratioOk || !sizeOk) ? (
        <div className="hint" style={{ color: 'var(--warn)', marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icon name="warning" size={13} /> {m.width}×{m.height}: Fortnite island thumbnails should be 1920×1080 (16:9). It will be cropped to fit.
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 4 }}>{m ? 'Shown behind the end card (PLAY NOW / island code).' : 'Your 1920×1080 island thumbnail, shown behind the end card.'}</div>
      )}
    </div>
  );
}

export type { MediaItem };
