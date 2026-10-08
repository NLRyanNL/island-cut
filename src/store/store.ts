// Minimal external store + React binding (no extra dependencies).
// Project edits go through commit()/transactions so undo/redo works on snapshots.
import { useRef, useSyncExternalStore } from 'react';
import type { Project, WaveformData, JobProgress, ExportJob } from '../../shared/types';
import type { ProxyInfo, PublicSettings } from '../../shared/api';
import { createProject } from '../../shared/defaults';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export interface QueueItem {
  job: ExportJob;
  progress: JobProgress;
}

export type DialogId =
  | 'export'
  | 'relink'
  | 'settings'
  | 'shortcuts'
  | 'queue'
  | 'newProject'
  | 'recover'
  | 'autoTrailer'
  | 'logoMaker'
  | 'report'
  | null;

export interface UIState {
  playhead: number;
  playing: boolean;
  /** playback rate for J/K/L shuttle (1 = normal) */
  rate: number;
  zoom: number; // px per second
  scrollX: number; // seconds at left edge
  selection: string[];
  snapping: boolean;
  showSafe: boolean;
  showLetterboxGuide: boolean;
  dialog: DialogId;
  binFilter: 'all' | 'video' | 'audio' | 'image' | 'music' | 'sfx';
  inspectorTab: string;
  timelineHeight: number;
  snapIndicator: number | null;
  /** extra dialog payload */
  dialogData?: unknown;
  /** frame-cache / revision counter for the preview */
  revision: number;
  /** beginner tips visible */
  showHints: boolean;
  /** first-launch tour visible */
  tour: boolean;
}

export interface RuntimeState {
  proxies: Record<string, ProxyInfo>;
  thumbs: Record<string, string>;
  waveforms: Record<string, WaveformData>;
  queue: QueueItem[];
  fonts: string[];
  /** fonts shipped with the app */
  bundledFonts: import('../../shared/api').BundledFont[];
  /** generated, copyright-free sound effects */
  builtinSfx: import('../../shared/api').BuiltinSfx[];
  /** newer version found by the update checker */
  update: import('../../shared/api').UpdateInfo | null;
  settings: PublicSettings | null;
  sfxFiles: string[];
  loadedFonts: Record<string, boolean>;
  busy: string | null;
  /** names of files being added right now (shown as placeholder cards in the Media bin) */
  importing: string[];
}

export interface State {
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  autosavedRevision: number;
  past: Project[];
  future: Project[];
  ui: UIState;
  rt: RuntimeState;
  toasts: Toast[];
}

type Listener = () => void;

function initialState(): State {
  return {
    project: createProject(),
    projectPath: null,
    dirty: false,
    autosavedRevision: 0,
    past: [],
    future: [],
    ui: {
      playhead: 0,
      playing: false,
      rate: 1,
      zoom: 80,
      scrollX: 0,
      selection: [],
      snapping: true,
      showSafe: false,
      showLetterboxGuide: false,
      dialog: null,
      binFilter: 'all',
      inspectorTab: 'video',
      timelineHeight: typeof window !== 'undefined' ? Math.max(300, Math.round(window.innerHeight * 0.44)) : 380,
      snapIndicator: null,
      revision: 1,
      showHints: (() => {
        try {
          return localStorage.getItem('islandcut.hints') !== 'off';
        } catch {
          return true;
        }
      })(),
      tour: false,
    },
    rt: {
      proxies: {},
      thumbs: {},
      waveforms: {},
      queue: [],
      fonts: [],
      bundledFonts: [],
      builtinSfx: [],
      update: null,
      settings: null,
      sfxFiles: [],
      loadedFonts: {},
      busy: null,
      importing: [],
    },
    toasts: [],
  };
}

let state: State = initialState();
const listeners = new Set<Listener>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function setUI(patch: Partial<UIState>): void {
  setState((s) => ({ ui: { ...s.ui, ...patch } }));
}

export function setRT(patch: Partial<RuntimeState> | ((rt: RuntimeState) => Partial<RuntimeState>)): void {
  setState((s) => ({ rt: { ...s.rt, ...(typeof patch === 'function' ? patch(s.rt) : patch) } }));
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** Subscribe to a slice of state. Re-renders only when the selected value changes (shallow). */
export function useStore<T>(selector: (s: State) => T): T {
  // keyed on state AND selector: a selector that closes over props (e.g. the selected id) must be
  // re-run when those props change even if the store did not
  const cache = useRef<{ s: State; sel: (s: State) => T; v: T } | null>(null);
  const get = () => {
    const c = cache.current;
    if (c && c.s === state && c.sel === selector) return c.v;
    const v = selector(state);
    if (c && shallowEqual(c.v, v)) {
      cache.current = { s: state, sel: selector, v: c.v };
      return c.v;
    }
    cache.current = { s: state, sel: selector, v };
    return v;
  };
  return useSyncExternalStore(subscribe, get, get);
}

// ------------------------------------------------------------------ history

const MAX_HISTORY = 200;
let txBase: Project | null = null;

function bump(s: State): UIState {
  return { ...s.ui, revision: s.ui.revision + 1 };
}

/** Apply an undoable change to the project. */
export function commit(fn: (draft: Project) => void): void {
  if (txBase) {
    // inside a transaction: apply to the live state AND the base, so the next updateTx
    // (which recomputes from the base) does not throw this change away
    const draft = structuredClone(state.project);
    fn(draft);
    const nb = structuredClone(txBase);
    fn(nb);
    txBase = nb;
    setState((s) => ({ project: draft, dirty: true, ui: bump(s) }));
    return;
  }
  const before = state.project;
  const draft = structuredClone(before);
  fn(draft);
  setState((s) => ({
    project: draft,
    past: [...s.past.slice(-MAX_HISTORY + 1), before],
    future: [],
    dirty: true,
    ui: bump(s),
  }));
}

/** Start an interactive edit (drag): intermediate states are not added to history. */
export function beginTx(): void {
  if (!txBase) txBase = state.project;
}

/** Replace the project during a transaction, computed from the transaction's base snapshot. */
export function updateTx(fn: (draft: Project) => void): void {
  const base = txBase ?? state.project;
  const draft = structuredClone(base);
  fn(draft);
  setState((s) => ({ project: draft, dirty: true, ui: bump(s) }));
}

export function txBaseProject(): Project {
  return txBase ?? state.project;
}

export function endTx(changed = true): void {
  if (!txBase) return;
  const base = txBase;
  txBase = null;
  if (!changed || base === state.project) {
    setState((s) => ({ project: base === state.project ? s.project : s.project }));
    return;
  }
  setState((s) => ({ past: [...s.past.slice(-MAX_HISTORY + 1), base], future: [] }));
}

export function cancelTx(): void {
  if (!txBase) return;
  const base = txBase;
  txBase = null;
  setState((s) => ({ project: base, ui: bump(s) }));
}

export function undo(): void {
  if (txBase) return;
  setState((s) => {
    if (!s.past.length) return {};
    const prev = s.past[s.past.length - 1];
    const selection = s.ui.selection.filter((id) => prev.clips[id]);
    return {
      project: prev,
      past: s.past.slice(0, -1),
      future: [s.project, ...s.future],
      dirty: true,
      ui: { ...bump(s), selection },
    };
  });
}

export function redo(): void {
  if (txBase) return;
  setState((s) => {
    if (!s.future.length) return {};
    const next = s.future[0];
    const selection = s.ui.selection.filter((id) => next.clips[id]);
    return {
      project: next,
      past: [...s.past, s.project],
      future: s.future.slice(1),
      dirty: true,
      ui: { ...bump(s), selection },
    };
  });
}

/** Replace the whole project (open/new) and reset history. */
export function loadProjectState(project: Project, path: string | null): void {
  txBase = null;
  setState((s) => ({
    project,
    projectPath: path,
    dirty: false,
    past: [],
    future: [],
    ui: { ...s.ui, playhead: 0, playing: false, selection: [], scrollX: 0, revision: s.ui.revision + 1 },
  }));
}

// ------------------------------------------------------------------ toasts

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? Math.max(ms, 8000) : ms);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
