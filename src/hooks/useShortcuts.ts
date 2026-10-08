import { checkUpdates } from '../updates';
import { openLogoMaker, openRemoveBackground } from '../components/logo/LogoMaker';
import { useEffect } from 'react';
import { commit, getState, setUI, toast } from '../store/store';
import {
  addMarkerAtPlayhead,
  addTextClip,
  deleteSelection,
  newProject,
  openProject,
  redo,
  saveProject,
  setPlayhead,
  shuttle,
  splitAtPlayhead,
  stepFrames,
  togglePlay,
  undo,
  zoomBy,
  zoomToFit,
  confirmDiscard,
} from '../store/actions';
import { clipEnd, placeClip, projectDuration, withLinked, rippleShift } from '../../shared/timelineOps';
import { uid } from '../../shared/time';
import { pickAndImport, chooseSfxFolder } from '../components/MediaBin';
import { exportAudio, exportFramePng } from '../components/dialogs/ExportDialog';

function editPoints(): number[] {
  const p = getState().project;
  const pts = new Set<number>([0]);
  for (const c of Object.values(p.clips)) {
    pts.add(+c.start.toFixed(5));
    pts.add(+clipEnd(c).toFixed(5));
  }
  return [...pts].sort((a, b) => a - b);
}

export function duplicateSelection(): void {
  const s = getState();
  const ids = withLinked(s.project, s.ui.selection);
  if (!ids.length) return;
  const clips = ids.map((id) => s.project.clips[id]).filter(Boolean);
  const a = Math.min(...clips.map((c) => c.start));
  const b = Math.max(...clips.map(clipEnd));
  const shift = b - a;
  const newIds: string[] = [];
  commit((p) => {
    const linkMap = new Map<string, string>();
    // insert, don't overwrite: push whatever follows on these tracks (and linked tracks) to the right
    const tracks = new Set(clips.map((c) => c.trackId).filter((tid) => !p.tracks.find((t) => t.id === tid)?.locked));
    rippleShift(p, tracks, b - 1e-6, shift);
    for (const c of clips) {
      if (!tracks.has(c.trackId)) continue;
      const n = structuredClone(c);
      n.id = uid('clp_');
      n.start = c.start + shift;
      if (c.linkId) {
        if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('lnk_'));
        n.linkId = linkMap.get(c.linkId);
      }
      placeClip(p, n);
      newIds.push(n.id);
    }
  });
  setUI({ selection: newIds });
}

export function runCommand(cmd: string): void {
  const s = getState();
  switch (cmd) {
    case 'new':
      setUI({ dialog: 'newProject' });
      break;
    case 'open':
      openProject();
      break;
    case 'save':
      saveProject(false);
      break;
    case 'saveAs':
      saveProject(true);
      break;
    case 'import':
      pickAndImport();
      break;
    case 'sfxFolder':
      chooseSfxFolder();
      break;
    case 'export':
      setUI({ dialog: 'export' });
      break;
    case 'exportAudio':
      exportAudio('audio-wav');
      break;
    case 'exportAudioMp3':
      exportAudio('audio-mp3');
      break;
    case 'exportFrame':
      exportFramePng();
      break;
    case 'renderQueue':
      setUI({ dialog: 'queue' });
      break;
    case 'recover':
      setUI({ dialog: 'recover' });
      break;
    case 'undo':
      undo();
      break;
    case 'redo':
      redo();
      break;
    case 'split':
      splitAtPlayhead();
      break;
    case 'delete':
      deleteSelection(false);
      break;
    case 'rippleDelete':
      deleteSelection(true);
      break;
    case 'marker':
      addMarkerAtPlayhead();
      break;
    case 'settings':
      setUI({ dialog: 'settings' });
      break;
    case 'zoomIn':
      zoomBy(1.4);
      break;
    case 'zoomOut':
      zoomBy(1 / 1.4);
      break;
    case 'zoomFit':
      zoomToFit((document.querySelector('.tl-scroll') as HTMLElement | null)?.clientWidth ?? 1000);
      break;
    case 'toggleSafe':
      setUI({ showSafe: !s.ui.showSafe });
      break;
    case 'toggleLetterboxGuide':
      setUI({ showLetterboxGuide: !s.ui.showLetterboxGuide });
      break;
    case 'shortcuts':
      setUI({ dialog: 'shortcuts' });
      break;
    case 'autoTrailer':
      setUI({ dialog: 'autoTrailer' });
      break;
    case 'checkUpdates':
      void checkUpdates(true);
      break;
    case 'reportProblem':
      setUI({ dialog: 'report' });
      break;
    case 'logoMaker':
      openLogoMaker();
      break;
    case 'removeBg':
      void openRemoveBackground();
      break;
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || t.isContentEditable) return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['range', 'checkbox', 'color', 'button'].includes(type);
  }
  if (tag === 'SELECT') return true;
  return false;
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getState().ui.dialog && e.key !== 'F1') return;
      if (isTyping(e)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;
      const lower = k.toLowerCase();
      let handled = true;
      if (ctrl) {
        if (lower === 'z' && !e.shiftKey) undo();
        else if (lower === 'y' || (lower === 'z' && e.shiftKey)) redo();
        else if (lower === 'b') splitAtPlayhead();
        else if (lower === 's') saveProject(e.shiftKey);
        else if (lower === 'o') openProject();
        else if (lower === 'n') confirmDiscard().then((ok) => ok && setUI({ dialog: 'newProject' }));
        else if (lower === 'i') pickAndImport();
        else if (lower === 'e' && e.shiftKey) exportFramePng();
        else if (lower === 'e') setUI({ dialog: 'export' });
        else if (lower === 'a') setUI({ selection: Object.keys(getState().project.clips) });
        else if (lower === 'd') duplicateSelection();
        else handled = false;
      } else {
        switch (k) {
          case ' ':
            togglePlay();
            break;
          case 'j':
          case 'J':
            shuttle(-1);
            break;
          case 'k':
          case 'K':
            shuttle(0);
            break;
          case 'l':
          case 'L':
            shuttle(1);
            break;
          case 'c':
          case 'C':
            splitAtPlayhead();
            break;
          case 'Delete':
          case 'Backspace':
            deleteSelection(e.shiftKey);
            break;
          case 'm':
          case 'M':
            addMarkerAtPlayhead();
            break;
          case 'ArrowLeft':
            stepFrames(e.shiftKey ? -10 : -1);
            break;
          case 'ArrowRight':
            stepFrames(e.shiftKey ? 10 : 1);
            break;
          case 'ArrowUp': {
            const t = getState().ui.playhead;
            const prev = [...editPoints()].reverse().find((x) => x < t - 1e-4);
            if (prev !== undefined) setPlayhead(prev);
            break;
          }
          case 'ArrowDown': {
            const t = getState().ui.playhead;
            const next = editPoints().find((x) => x > t + 1e-4);
            if (next !== undefined) setPlayhead(next);
            break;
          }
          case 'Home':
            setPlayhead(0);
            break;
          case 'End':
            setPlayhead(projectDuration(getState().project));
            break;
          case '+':
          case '=':
            zoomBy(1.4);
            break;
          case '-':
          case '_':
            zoomBy(1 / 1.4);
            break;
          case 'Z':
            if (e.shiftKey) runCommand('zoomFit');
            else handled = false;
            break;
          case 's':
          case 'S':
            setUI({ snapping: !getState().ui.snapping });
            toast(`Snapping ${getState().ui.snapping ? 'on' : 'off'}`, 'info', 900);
            break;
          case 't':
          case 'T':
            addTextClip();
            break;
          case 'i':
          case 'I':
            commit((p) => void (p.inPoint = getState().ui.playhead));
            break;
          case 'o':
          case 'O':
            commit((p) => void (p.outPoint = getState().ui.playhead));
            break;
          case 'Escape':
            setUI({ selection: [] });
            break;
          case 'F1':
            setUI({ dialog: 'shortcuts' });
            break;
          default:
            handled = false;
        }
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export { newProject };
