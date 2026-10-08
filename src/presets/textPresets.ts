import type { Clip, Project, TextProps } from '../../shared/types';
import { defaultText } from '../../shared/defaults';

export interface TextPreset {
  id: string;
  label: string;
  description: string;
  apply: (c: Clip, p: Project) => void;
}

const vertical = (p: Project) => p.settings.aspect === '9:16';

function style(c: Clip, patch: Partial<TextProps>): void {
  c.text = { ...(c.text ?? defaultText()), ...patch };
}

export const TEXT_PRESETS: TextPreset[] = [
  {
    id: 'fadeUp',
    label: 'Fade up',
    description: 'Clean title that fades and rises in',
    apply: (c) => style(c, { animIn: 'fadeUp', animInDuration: 0.6, animOut: 'fadeUp', animOutDuration: 0.4 }),
  },
  {
    id: 'scalePunch',
    label: 'Scale punch',
    description: 'Pops in with an overshoot — good on a beat',
    apply: (c) => style(c, { animIn: 'scalePunch', animInDuration: 0.35, animOut: 'scalePunch', animOutDuration: 0.25 }),
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    description: 'Types the text letter by letter',
    apply: (c) => style(c, { animIn: 'typewriter', animInDuration: Math.max(0.6, (c.text?.text.length ?? 10) * 0.06), animOut: 'fadeUp', animOutDuration: 0.3, fontFamily: 'Consolas', fontWeight: 700, letterSpacing: 4 }),
  },
  {
    id: 'glitchIn',
    label: 'Glitch in',
    description: 'RGB split + slice glitch reveal',
    apply: (c) => style(c, { animIn: 'glitchIn', animInDuration: 0.6, animOut: 'glitchIn', animOutDuration: 0.35 }),
  },
  {
    id: 'slam',
    label: 'Slam',
    description: 'Big text hits the screen with a shake',
    apply: (c) =>
      style(c, {
        animIn: 'slam',
        animInDuration: 0.55,
        animOut: 'fadeUp',
        animOutDuration: 0.3,
        fontFamily: 'Impact',
        fontWeight: 900,
        fontSize: 190,
        uppercase: true,
        letterSpacing: 4,
        shadowBlur: 30,
        shadowOffset: 8,
      }),
  },
  {
    id: 'comingSoon',
    label: 'COMING SOON',
    description: 'Trailer card',
    apply: (c, p) =>
      style(c, {
        text: 'COMING SOON',
        fontFamily: 'Arial Black',
        fontWeight: 900,
        fontSize: vertical(p) ? 120 : 150,
        color: '#ffffff',
        letterSpacing: 10,
        uppercase: true,
        outlineWidth: 0,
        shadowBlur: 40,
        shadowOffset: 0,
        shadowColor: 'rgba(80,160,255,0.85)',
        animIn: 'slam',
        animInDuration: 0.55,
        animOut: 'fadeUp',
        animOutDuration: 0.4,
        posX: 0.5,
        posY: 0.5,
        align: 'center',
        box: false,
        accentBar: false,
        subText: undefined,
      }),
  },
  {
    id: 'playNow',
    label: 'PLAY NOW',
    description: 'Call to action',
    apply: (c, p) =>
      style(c, {
        text: 'PLAY NOW',
        fontFamily: 'Arial Black',
        fontWeight: 900,
        fontSize: vertical(p) ? 140 : 170,
        color: '#ffd23f',
        outlineColor: '#1a1030',
        outlineWidth: 6,
        letterSpacing: 6,
        uppercase: true,
        shadowBlur: 24,
        shadowOffset: 8,
        shadowColor: 'rgba(0,0,0,0.7)',
        animIn: 'scalePunch',
        animInDuration: 0.4,
        animOut: 'none',
        posX: 0.5,
        posY: vertical(p) ? 0.42 : 0.45,
        align: 'center',
        box: false,
        accentBar: false,
        subText: undefined,
      }),
  },
  {
    id: 'islandCode',
    label: 'Island code box',
    description: 'Island code in a bold box (use under a title)',
    apply: (c, p) =>
      style(c, {
        text: c.text?.text && /\d{4}-\d{4}-\d{4}/.test(c.text.text) ? c.text.text : '1234-5678-9012',
        fontFamily: 'Consolas',
        fontWeight: 800,
        fontSize: vertical(p) ? 74 : 84,
        color: '#ffffff',
        letterSpacing: 6,
        uppercase: false,
        outlineWidth: 0,
        shadowBlur: 0,
        shadowOffset: 0,
        box: true,
        boxColor: '#2a2f7a',
        boxPadding: 34,
        boxRadius: 18,
        accentBar: false,
        animIn: 'fadeUp',
        animInDuration: 0.45,
        animOut: 'none',
        posX: 0.5,
        posY: vertical(p) ? 0.56 : 0.66,
        align: 'center',
        subText: undefined,
      }),
  },
  {
    id: 'lowerThird',
    label: 'Lower third',
    description: 'Feature callout bottom-left',
    apply: (c, p) =>
      style(c, {
        text: c.text?.text && c.text.text !== 'YOUR TITLE' ? c.text.text : 'NEW FEATURE',
        subText: c.text?.subText ?? 'Describe the feature in a few words',
        subSize: 34,
        subColor: '#c9d3ff',
        fontFamily: 'Arial Black',
        fontWeight: 900,
        fontSize: 60,
        color: '#ffffff',
        letterSpacing: 2,
        uppercase: true,
        outlineWidth: 0,
        shadowBlur: 0,
        shadowOffset: 0,
        box: true,
        boxColor: 'rgba(12,14,30,0.82)',
        boxPadding: 26,
        boxRadius: 6,
        accentBar: true,
        accentColor: '#ffd23f',
        animIn: 'fadeUp',
        animInDuration: 0.4,
        animOut: 'fadeUp',
        animOutDuration: 0.3,
        posX: vertical(p) ? 0.08 : 0.07,
        posY: vertical(p) ? 0.7 : 0.8,
        align: 'left',
      }),
  },
];

export function presetById(id: string): TextPreset | undefined {
  return TEXT_PRESETS.find((p) => p.id === id);
}
