// Worker thread for CPU-heavy analysis so the main process (IPC, menus) never stalls.
import { parentPort } from 'node:worker_threads';
import { detectBeats } from '../shared/beatDetect';
import { analyzeFootage } from '../shared/analysis';

interface Msg {
  id: number;
  task: 'beats' | 'analyze';
  samples: Float32Array;
  sampleRate: number;
  fi: { frames: Uint8Array; w: number; h: number; fps: number } | null;
  audio: Float32Array | null;
  sr: number;
  duration: number;
}

parentPort?.on('message', (m: Msg) => {
  try {
    if (m.task === 'beats') {
      parentPort!.postMessage({ id: m.id, ok: true, result: detectBeats(m.samples, m.sampleRate) });
    } else if (m.task === 'analyze') {
      parentPort!.postMessage({ id: m.id, ok: true, result: analyzeFootage(m.fi, m.audio, m.sr, m.duration) });
    }
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: (e as Error).message });
  }
});
