import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  const file = path.join(__dirname, 'worker.cjs');
  if (!fs.existsSync(file)) return null;
  worker = new Worker(file);
  worker.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
  });
  worker.on('error', (e) => {
    for (const p of pending.values()) p.reject(e as Error);
    pending.clear();
    worker = null;
  });
  return worker;
}

/** Run a task in the analysis worker; falls back to running inline (e.g. in tests). */
export function runInWorker<T>(task: string, payload: Record<string, unknown>, fallback: () => T): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.resolve().then(fallback);
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, task, ...payload });
  });
}
