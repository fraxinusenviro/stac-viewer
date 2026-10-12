// Runs one OBIA job in the worker. `cancel()` terminates the worker — the
// only way to stop a synchronous computation mid-way in a browser — and the
// next job starts a fresh one. A cancelled job rejects with `cancelled`.

import type { ObjectsJob, ObjectsResult } from './pipeline.ts';
import type { ClassifyJob, ClassifyResult } from './classify.ts';

let worker: Worker | null = null;
let seq = 0;

function get(): Worker {
  worker ??= new Worker(new URL('./obiaWorker.ts', import.meta.url), { type: 'module' });
  return worker;
}

export interface Running<T> { promise: Promise<T>; cancel: () => void }

function run<T>(type: 'objects' | 'classify', job: ObjectsJob | ClassifyJob, transfer: Transferable[], onProgress: (s: string) => void): Running<T> {
  const w = get(), id = ++seq;
  let settle: { resolve: (v: T) => void; reject: (e: Error) => void } | null = null;
  const promise = new Promise<T>((resolve, reject) => { settle = { resolve, reject }; });
  const onMsg = (e: MessageEvent) => {
    const d = e.data;
    if (d.id !== id) return;
    if (d.progress) { onProgress(d.progress); return; }
    w.removeEventListener('message', onMsg);
    if (d.ok) settle!.resolve(d.result as T); else settle!.reject(new Error(d.error));
  };
  const onErr = (e: ErrorEvent) => { w.removeEventListener('message', onMsg); settle!.reject(new Error(e.message || 'the analysis worker failed')); };
  w.addEventListener('message', onMsg);
  w.addEventListener('error', onErr, { once: true });
  w.postMessage({ id, type, job }, transfer);
  return {
    promise,
    cancel: () => { w.terminate(); if (worker === w) worker = null; settle!.reject(new Error('cancelled')); },
  };
}

export function runObjectsJob(job: ObjectsJob, onProgress: (s: string) => void): Running<ObjectsResult> {
  // The fine planes are transferred, not copied: the caller must not use them afterwards.
  const transfer = [...new Set(Object.values(job.planes).filter(Boolean).map(a => (a as Float32Array).buffer))];
  return run('objects', job, transfer as ArrayBuffer[], onProgress);
}

export function runClassifyJob(job: ClassifyJob, onProgress: (s: string) => void): Running<ClassifyResult> {
  return run('classify', job, [], onProgress);
}
