// Built-in sound effects, synthesized with the bundled FFmpeg the first time they are needed.
// Because they are generated (not recorded), they are free of copyright for everyone.
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from './paths';
import { runFfmpeg, ffmpegError } from './ffmpeg/run';
import { allowPath } from './ipc';
import type { BuiltinSfx } from '../shared/api';

const ST = 'pan=stereo|c0=c0|c1=c0';
const END = 'alimiter=limit=0.9:level=disabled';

export const SFX_RECIPES: { id: string; name: string; use: string; graph: string }[] = [
  {
    id: 'whoosh',
    name: 'Whoosh',
    use: 'transitions',
    graph: `anoisesrc=d=1.0:c=pink:a=0.9:r=48000,bandpass=f=900:width_type=o:w=2.4,volume='0.1+1.9*pow(sin(PI*t/1.0),3)':eval=frame,afade=t=out:st=0.86:d=0.14,${ST},extrastereo=m=1.6,${END}`,
  },
  {
    id: 'whoosh-fast',
    name: 'Whoosh (fast)',
    use: 'quick cuts',
    graph: `anoisesrc=d=0.45:c=pink:a=0.9:r=48000,bandpass=f=1400:width_type=o:w=2,volume='0.1+2*pow(sin(PI*t/0.45),2)':eval=frame,afade=t=out:st=0.38:d=0.07,${ST},${END}`,
  },
  {
    id: 'reverse-whoosh',
    name: 'Reverse whoosh',
    use: 'into a reveal',
    graph: `anoisesrc=d=1.2:c=pink:a=1:r=48000,bandpass=f=1100:width_type=o:w=2.5,volume='1.8*pow(t/1.2,3)':eval=frame,afade=t=out:st=1.17:d=0.03,${ST},${END}`,
  },
  {
    id: 'riser',
    name: 'Riser',
    use: 'build-up before the title',
    graph: `aevalsrc='0.22*sin(2*PI*(180*t+120*t*t))*pow(t/3,1.5)+0.12*sin(2*PI*(270*t+180*t*t))*pow(t/3,2)':d=3:s=48000[a];anoisesrc=d=3:c=white:a=0.5:r=48000,highpass=f=2500,volume='0.7*pow(t/3,3)':eval=frame[n];[a][n]amix=inputs=2:normalize=0,afade=t=out:st=2.93:d=0.07,${ST},${END}`,
  },
  {
    id: 'boom',
    name: 'Boom',
    use: 'title reveal, end card',
    graph: `aevalsrc='0.95*sin(2*PI*(52*t-6*t*t))*exp(-2.4*t)+0.45*sin(2*PI*104*t)*exp(-6*t)':d=2.5:s=48000[a];anoisesrc=d=2.5:c=brown:a=1:r=48000,lowpass=f=400,volume='exp(-9*t)':eval=frame[n];[a][n]amix=inputs=2:normalize=0,${ST},${END}`,
  },
  {
    id: 'hit',
    name: 'Hit',
    use: 'punchy cuts',
    graph: `aevalsrc='0.9*sin(2*PI*(110*t-30*t*t))*exp(-10*t)':d=0.7:s=48000[a];anoisesrc=d=0.7:c=white:a=0.8:r=48000,highpass=f=1500,volume='exp(-35*t)':eval=frame[n];[a][n]amix=inputs=2:normalize=0,${ST},${END}`,
  },
  {
    id: 'braam',
    name: 'Braam',
    use: 'epic / horror moments',
    graph: `aevalsrc='0.34*(sin(2*PI*55*t)+0.8*sin(2*PI*110.4*t)+0.6*sin(2*PI*165*t)+0.5*sin(2*PI*220.7*t)+0.4*sin(2*PI*275*t)+0.3*sin(2*PI*330.5*t))*min(1,t*12)*exp(-0.55*t)':d=3.5:s=48000,lowpass=f=900,aecho=0.8:0.6:40:0.3,${ST},${END}`,
  },
  {
    id: 'sub-drop',
    name: 'Sub drop',
    use: 'before the drop',
    graph: `aevalsrc='0.9*sin(2*PI*(80*t-12.5*t*t))*exp(-1.2*t)':d=2:s=48000,${ST},${END}`,
  },
  {
    id: 'glitch',
    name: 'Glitch',
    use: 'glitch transitions',
    graph: `aevalsrc='0.35*sgn(sin(2*PI*(220+660*mod(floor(t*24)*37,7)/7)*t))*lt(mod(t*24,1),0.75)':d=0.6:s=48000,lowpass=f=6000,${ST},${END}`,
  },
  {
    id: 'heartbeat',
    name: 'Heartbeat',
    use: 'horror tension',
    graph: `aevalsrc='0.95*sin(2*PI*48*t)*exp(-16*t)+0.75*gte(t,0.3)*sin(2*PI*44*(t-0.3))*exp(-16*(t-0.3))':d=1.3:s=48000,lowpass=f=220,volume=2,${ST},${END}`,
  },
  {
    id: 'camera-click',
    name: 'Camera click',
    use: 'freeze frames',
    graph: `anoisesrc=d=0.25:c=white:a=1:r=48000,highpass=f=2000,volume='exp(-60*t)+gte(t,0.08)*exp(-80*(t-0.08))':eval=frame,${ST},${END}`,
  },
  {
    id: 'coin',
    name: 'Coin / ding',
    use: 'fun moments',
    graph: `aevalsrc='0.4*sin(2*PI*1320*t)*exp(-5*t)+0.3*sin(2*PI*1980*t)*exp(-7*t)':d=0.8:s=48000,${ST},${END}`,
  },
];

let generating: Promise<BuiltinSfx[]> | null = null;

/** Make sure every built-in sound exists (generated once into the cache) and return them. */
export function builtinSfx(): Promise<BuiltinSfx[]> {
  if (generating) return generating;
  generating = (async () => {
    const dir = cacheDir('sfx');
    fs.mkdirSync(dir, { recursive: true });
    const out: BuiltinSfx[] = [];
    for (const r of SFX_RECIPES) {
      const file = path.join(dir, `IslandCut ${r.name.replace(/[^\w ()-]/g, '')}.wav`);
      if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
        const res = await runFfmpeg(['-y', '-filter_complex', `${r.graph}[o]`, '-map', '[o]', '-ar', '48000', '-c:a', 'pcm_s16le', file], {});
        if (res.code !== 0) throw new Error(`${r.name}: ${ffmpegError(res.stderr)}`);
      }
      allowPath(file);
      out.push({ id: r.id, name: r.name, use: r.use, path: file });
    }
    return out;
  })();
  generating.catch(() => (generating = null));
  return generating;
}
