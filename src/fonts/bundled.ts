// Fonts shipped with IslandCut (downloaded at build time by scripts/fetch-fonts.mjs).
// All faces are registered with document.fonts at startup so the text renderer, the preview,
// the export and the logo maker can use them by family name.
import type { BundledFont } from '../../shared/api';
import { setRT } from '../store/store';

let loading: Promise<void> | null = null;

export function loadBundledFonts(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    let list: BundledFont[] = [];
    try {
      list = await window.api.bundledFonts();
    } catch {
      list = [];
    }
    setRT({ bundledFonts: list });
    await Promise.all(
      list.flatMap((f) =>
        f.faces.map(async (face) => {
          try {
            const bytes = await window.api.bundledFontBytes(face.file);
            const ff = new FontFace(f.family, bytes.buffer as ArrayBuffer, { weight: String(face.weight), style: 'normal' });
            await ff.load();
            document.fonts.add(ff);
          } catch {
            /* a broken font file is skipped */
          }
        }),
      ),
    );
    // text rendered before the fonts arrived must be redrawn
    window.dispatchEvent(new Event('islandcut-fonts-loaded'));
  })();
  return loading;
}

/** Resolves once bundled fonts are registered (call before rendering text for export). */
export function bundledFontsReady(): Promise<void> {
  return loading ?? loadBundledFonts();
}

/** Make sure a specific family/weight is ready before drawing with it. */
export async function ensureFont(family: string, weight = 400): Promise<void> {
  await bundledFontsReady();
  try {
    await document.fonts.load(`${weight} 48px "${family}"`);
  } catch {
    /* system fallback */
  }
}
