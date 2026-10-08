// Downloads the bundled trailer fonts (all SIL Open Font License / Apache, free to redistribute)
// from the npm registry (Fontsource packages) into resources/fonts, with their licence files.
// Runs before every build; already-downloaded fonts are skipped, and a font that fails to download
// is simply left out (the build never fails because of a font).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'resources', 'fonts');

// [fontsource id, display family, category]
export const FONTS = [
  // big & bold trailer titles
  ['bebas-neue', 'Bebas Neue', 'Trailer'],
  ['anton', 'Anton', 'Trailer'],
  ['oswald', 'Oswald', 'Trailer'],
  ['league-gothic', 'League Gothic', 'Trailer'],
  ['archivo-black', 'Archivo Black', 'Trailer'],
  ['alfa-slab-one', 'Alfa Slab One', 'Trailer'],
  ['big-shoulders-display', 'Big Shoulders Display', 'Trailer'],
  ['staatliches', 'Staatliches', 'Trailer'],
  ['teko', 'Teko', 'Trailer'],
  ['barlow-condensed', 'Barlow Condensed', 'Trailer'],
  ['saira-condensed', 'Saira Condensed', 'Trailer'],
  ['squada-one', 'Squada One', 'Trailer'],
  ['passion-one', 'Passion One', 'Trailer'],
  ['bowlby-one', 'Bowlby One', 'Trailer'],
  ['ultra', 'Ultra', 'Trailer'],
  ['dela-gothic-one', 'Dela Gothic One', 'Trailer'],
  ['black-han-sans', 'Black Han Sans', 'Trailer'],
  // gaming / sci-fi
  ['black-ops-one', 'Black Ops One', 'Gaming'],
  ['russo-one', 'Russo One', 'Gaming'],
  ['orbitron', 'Orbitron', 'Gaming'],
  ['audiowide', 'Audiowide', 'Gaming'],
  ['rajdhani', 'Rajdhani', 'Gaming'],
  ['exo-2', 'Exo 2', 'Gaming'],
  ['chakra-petch', 'Chakra Petch', 'Gaming'],
  ['michroma', 'Michroma', 'Gaming'],
  ['zen-dots', 'Zen Dots', 'Gaming'],
  ['bungee', 'Bungee', 'Gaming'],
  ['bungee-shade', 'Bungee Shade', 'Gaming'],
  ['press-start-2p', 'Press Start 2P', 'Gaming'],
  ['silkscreen', 'Silkscreen', 'Gaming'],
  ['racing-sans-one', 'Racing Sans One', 'Gaming'],
  ['faster-one', 'Faster One', 'Gaming'],
  ['rubik-mono-one', 'Rubik Mono One', 'Gaming'],
  ['rubik-glitch', 'Rubik Glitch', 'Gaming'],
  // fun / cartoon (Fortnite-style)
  ['luckiest-guy', 'Luckiest Guy', 'Fun'],
  ['bangers', 'Bangers', 'Fun'],
  ['lilita-one', 'Lilita One', 'Fun'],
  ['titan-one', 'Titan One', 'Fun'],
  ['fredoka', 'Fredoka', 'Fun'],
  ['changa-one', 'Changa One', 'Fun'],
  ['knewave', 'Knewave', 'Fun'],
  ['londrina-solid', 'Londrina Solid', 'Fun'],
  ['righteous', 'Righteous', 'Fun'],
  ['permanent-marker', 'Permanent Marker', 'Fun'],
  ['sedgwick-ave-display', 'Sedgwick Ave Display', 'Fun'],
  ['rubik-wet-paint', 'Rubik Wet Paint', 'Fun'],
  ['monoton', 'Monoton', 'Fun'],
  // horror / fantasy / cinematic
  ['creepster', 'Creepster', 'Horror & fantasy'],
  ['nosifer', 'Nosifer', 'Horror & fantasy'],
  ['metal-mania', 'Metal Mania', 'Horror & fantasy'],
  ['pirata-one', 'Pirata One', 'Horror & fantasy'],
  ['special-elite', 'Special Elite', 'Horror & fantasy'],
  ['cinzel', 'Cinzel', 'Cinematic'],
  ['cinzel-decorative', 'Cinzel Decorative', 'Cinematic'],
  ['playfair-display', 'Playfair Display', 'Cinematic'],
  ['bree-serif', 'Bree Serif', 'Cinematic'],
  // clean text
  ['montserrat', 'Montserrat', 'Clean'],
  ['poppins', 'Poppins', 'Clean'],
  ['kanit', 'Kanit', 'Clean'],
  ['inter', 'Inter', 'Clean'],
  ['roboto-condensed', 'Roboto Condensed', 'Clean'],
];

const REGISTRY = process.env.npm_config_registry?.replace(/\/$/, '') || 'https://registry.npmjs.org';

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Minimal tar reader: returns { name -> Buffer } for entries accepted by `want`. */
function untar(buf, want) {
  const out = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    if ((type === '0' || type === '\0') && want(name)) out[name] = Buffer.from(buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

async function fetchFont([id, family, category]) {
  const meta = JSON.parse((await get(`${REGISTRY}/@fontsource%2f${id}/latest`)).toString());
  const tgz = await get(meta.dist.tarball);
  const files = untar(zlib.gunzipSync(tgz), (n) => /^package\/files\/.*-latin-\d+-normal\.woff2$/.test(n) || /^package\/LICEN[SC]E/i.test(n));
  const weights = Object.keys(files)
    .map((n) => /-latin-(\d+)-normal\.woff2$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  if (!weights.length) throw new Error('no latin woff2 files');
  const regular = weights.includes(400) ? 400 : weights.reduce((a, w) => (Math.abs(w - 400) < Math.abs(a - 400) ? w : a));
  const heavy = Math.max(...weights);
  const pick = [...new Set([regular, heavy >= 700 ? heavy : regular])];
  const faces = [];
  for (const w of pick) {
    const src = Object.keys(files).find((n) => n.endsWith(`-latin-${w}-normal.woff2`));
    const file = `${id}-${w}.woff2`;
    fs.writeFileSync(path.join(OUT, file), files[src]);
    faces.push({ weight: w, file });
  }
  const lic = Object.keys(files).find((n) => /LICEN[SC]E/i.test(n));
  if (lic) fs.writeFileSync(path.join(OUT, `${id}.LICENSE.txt`), files[lic]);
  return { id, family, category, faces, license: meta.license ?? 'OFL-1.1', version: meta.version };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, 'fonts.json');
  let old = [];
  try {
    old = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    /* first run */
  }
  const have = new Map(old.filter((f) => f.faces.every((x) => fs.existsSync(path.join(OUT, x.file)))).map((f) => [f.id, f]));
  const result = [];
  let fetched = 0;
  let failed = 0;
  const queue = [...FONTS];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      if (have.has(f[0])) {
        result.push({ ...have.get(f[0]), family: f[1], category: f[2] });
        continue;
      }
      try {
        result.push(await fetchFont(f));
        fetched++;
      } catch (e) {
        failed++;
        console.warn(`  font ${f[1]}: skipped (${e.message})`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const order = new Map(FONTS.map((f, i) => [f[0], i]));
  result.sort((a, b) => order.get(a.id) - order.get(b.id));
  fs.writeFileSync(manifestPath, JSON.stringify(result, null, 1));
  console.log(`fonts: ${result.length} bundled (${fetched} downloaded, ${failed} skipped)`);
}

main().catch((e) => {
  // never break the build because of fonts
  console.warn(`fonts: download failed (${e.message}); building without bundled fonts`);
  process.exit(0);
});
