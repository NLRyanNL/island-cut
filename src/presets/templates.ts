// Project templates (timeline skeletons with section markers + placeholder titles) and aspect switching.
import type { AspectId, Clip, Project } from '../../shared/types';
import { ASPECTS, createProject, defaultAdjust, defaultText, makeClip } from '../../shared/defaults';
import { addMarker, addTrack, placeClip, tracksOfKind, clipEnd, isRangeFree } from '../../shared/timelineOps';
import { presetById } from './textPresets';
import { commit, getState, setUI, toast } from '../store/store';
import { constProp } from '../../shared/keyframes';
import { snapFrame } from '../../shared/time';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  aspect: AspectId;
  duration: number;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: 'empty', name: 'Empty project', description: 'Start from scratch', aspect: '16:9', duration: 0 },
  { id: 'gameplay30', name: 'Gameplay Trailer (30s)', description: 'Hook → features → action montage → end card with island code', aspect: '16:9', duration: 30 },
  { id: 'cinematic60', name: 'Cinematic Trailer (60s)', description: 'Slow build → reveal → beat-synced action → title → end card', aspect: '16:9', duration: 60 },
  { id: 'short15', name: 'Short / TikTok (15s, 9:16)', description: 'Vertical hook → action → end card, safe for Shorts UI', aspect: '9:16', duration: 15 },
];

function textClip(p: Project, trackId: string, start: number, dur: number, presetId: string, text?: string, sub?: string): Clip {
  const c = makeClip('text', trackId, start, dur, { name: text ?? presetId, fit: 'fit', text: defaultText(text ?? 'TITLE') });
  presetById(presetId)?.apply(c, p);
  if (text) c.text!.text = text;
  if (sub !== undefined) c.text!.subText = sub;
  c.name = (text ?? c.text!.text).split('\n')[0];
  return c;
}

function section(p: Project, t: number, label: string, color = '#7c5cff'): void {
  addMarker(p, t, 'section', label, color);
}

/** Places the "PLAY NOW / title + island code" end card on the text tracks. */
export function endCard(p: Project, start: number, dur: number, title = 'PLAY NOW', code = '1234-5678-9012'): void {
  const texts = tracksOfKind(p, 'text');
  const t1 = texts[0] ?? addTrack(p, 'text');
  const t2 = texts[1] ?? addTrack(p, 'text');
  placeClip(p, textClip(p, t1.id, start, dur, 'playNow', title));
  const codeClip = textClip(p, t2.id, start + 0.25, dur - 0.25, 'islandCode', code);
  placeClip(p, codeClip);
}

export function buildTemplate(id: string, fps = 60): Project {
  const info = TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
  const p = createProject(info.name, info.aspect, fps);
  if (id === 'empty') return p;
  const T = tracksOfKind(p, 'text')[0];
  const vTop = tracksOfKind(p, 'video')[0];
  if (id === 'gameplay30') {
    section(p, 0, 'HOOK — your single best moment (0-3s)', '#ff4d6d');
    section(p, 3, 'FEATURES — show what makes your island unique', '#4f8cff');
    section(p, 12, 'ACTION MONTAGE — cut on the beat', '#ffb020');
    section(p, 24, 'END CARD — island code', '#3ccf8e');
    placeClip(p, textClip(p, T.id, 0.4, 2.4, 'slam', 'YOUR HOOK'));
    placeClip(p, textClip(p, T.id, 3.4, 2.4, 'lowerThird', 'FEATURE ONE', 'What players can do'));
    placeClip(p, textClip(p, T.id, 6.4, 2.4, 'lowerThird', 'FEATURE TWO', 'Another cool mechanic'));
    placeClip(p, textClip(p, T.id, 9.4, 2.4, 'lowerThird', 'FEATURE THREE', 'Why it is fun with friends'));
    endCard(p, 24.5, 5.5, 'PLAY NOW');
  } else if (id === 'cinematic60') {
    section(p, 0, 'SLOW BUILD — wide, slow shots, ambience', '#7c5cff');
    section(p, 15, 'REVEAL — first look at the threat / world', '#ff4d6d');
    section(p, 25, 'BEAT-SYNCED ACTION — fast cuts on the beat', '#ffb020');
    section(p, 45, 'TITLE', '#4f8cff');
    section(p, 52, 'END CARD', '#3ccf8e');
    const lb = makeClip('adjust', vTop.id, 0, 25, { name: 'Letterbox 2.39:1', adjust: defaultAdjust() });
    placeClip(p, lb);
    placeClip(p, textClip(p, T.id, 3, 4, 'fadeUp', 'SOMETHING IS COMING'));
    placeClip(p, textClip(p, T.id, 17, 3, 'glitchIn', 'NOWHERE IS SAFE'));
    const title = textClip(p, T.id, 45.5, 6, 'slam', 'YOUR ISLAND NAME');
    title.text!.fontSize = 180;
    placeClip(p, title);
    const cs = textClip(p, T.id, 52.3, 3.4, 'comingSoon', 'COMING SOON');
    placeClip(p, cs);
    endCard(p, 55.8, 4.2, 'PLAY NOW');
  } else if (id === 'short15') {
    section(p, 0, 'HOOK (0-2s) — big text + best moment', '#ff4d6d');
    section(p, 2, 'ACTION — fast cuts, keep the subject centered', '#ffb020');
    section(p, 12, 'END CARD — island code', '#3ccf8e');
    const hook = textClip(p, T.id, 0.2, 1.8, 'scalePunch', 'WAIT FOR IT…');
    hook.text!.posY = 0.3;
    hook.text!.fontSize = 110;
    placeClip(p, hook);
    endCard(p, 12.2, 2.8, 'PLAY NOW');
  }
  p.outPoint = info.duration;
  p.inPoint = 0;
  return p;
}

/** Change the project aspect ratio, optionally auto-reframing clips to keep their center in frame. */
export async function applyAspect(aspect: AspectId): Promise<void> {
  const s = getState();
  if (s.project.settings.aspect === aspect) return;
  const hasVideo = Object.values(s.project.clips).some((c) => c.kind === 'video' || c.kind === 'image');
  let reframe = false;
  if (hasVideo) {
    const r = await window.api.confirm({
      message: `Switch to ${ASPECTS[aspect].label}?`,
      detail: 'Auto-reframe fills the new frame and keeps the center of each shot in view. You can keyframe the focus point per clip in Inspector → Transform → Auto-reframe.',
      buttons: ['Auto-reframe clips', 'Keep framing (fit)', 'Cancel'],
      cancelId: 2,
      defaultId: 0,
    });
    if (r === 2) return;
    reframe = r === 0;
  }
  commit((p) => {
    const a = ASPECTS[aspect];
    const oldH = p.settings.height;
    p.settings.aspect = aspect;
    p.settings.width = a.width;
    p.settings.height = a.height;
    for (const c of Object.values(p.clips)) {
      if (c.kind === 'video' || c.kind === 'image') {
        if (reframe) {
          c.fit = 'fill';
          c.reframe = { enabled: true, focusX: c.reframe?.focusX ?? constProp(0.5), focusY: c.reframe?.focusY ?? constProp(0.5) };
        } else if (!reframe && hasVideo) {
          c.fit = 'fit';
        }
      }
      // keep pixel offsets proportional
      const k = a.height / oldH;
      if (c.transform.x.keys) c.transform.x.keys = c.transform.x.keys.map((kk) => ({ ...kk, v: kk.v * k }));
      else c.transform.x = { value: c.transform.x.value * k };
      if (c.transform.y.keys) c.transform.y.keys = c.transform.y.keys.map((kk) => ({ ...kk, v: kk.v * k }));
      else c.transform.y = { value: c.transform.y.value * k };
    }
  });
  toast(`Project is now ${ASPECTS[aspect].label}${reframe ? ' — clips auto-reframed' : ''}`, 'success');
}

/** Add a multi-clip title preset at the playhead (used by the toolbar's title menu). */
export function addTitlePreset(kind: 'endCard' | 'comingSoon' | 'playNow' | 'lowerThird' | 'slam'): void {
  const s = getState();
  const t = snapFrame(s.ui.playhead, s.project.settings.fps);
  commit((p) => {
    if (kind === 'endCard') {
      endCard(p, t, 4);
      return;
    }
    let tr = tracksOfKind(p, 'text').find((x) => !x.locked && isRangeFree(p, x.id, t, t + 3));
    if (!tr) tr = addTrack(p, 'text');
    const map = { comingSoon: ['comingSoon', 'COMING SOON'], playNow: ['playNow', 'PLAY NOW'], lowerThird: ['lowerThird', 'NEW FEATURE'], slam: ['slam', 'BIG MOMENT'] } as const;
    const [pid, txt] = map[kind];
    const c = textClip(p, tr.id, t, 3, pid, txt);
    placeClip(p, c);
    setTimeout(() => setUI({ selection: [c.id], inspectorTab: 'text' }));
  });
}

export { clipEnd };
