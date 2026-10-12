// The OBIA worker: segmentation, object features, Sentinel statistics,
// training and prediction off the main thread, so the map stays responsive.
// One job at a time; CANCELLATION terminates the worker (workerClient.ts),
// which frees every buffer it held at once.

import { runObjects, type ObjectsJob } from './pipeline.ts';
import { runClassify, type ClassifyJob } from './classify.ts';

type Msg = { id: number; type: 'objects'; job: ObjectsJob } | { id: number; type: 'classify'; job: ClassifyJob };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  const progress = (stage: string) => (self as unknown as Worker).postMessage({ id: m.id, progress: stage });
  try {
    if (m.type === 'objects') {
      const r = runObjects(m.job, progress);
      (self as unknown as Worker).postMessage({ id: m.id, ok: true, result: r }, [r.labels.buffer]);
    } else {
      progress('training and cross-validating');
      const r = runClassify(m.job);
      (self as unknown as Worker).postMessage({ id: m.id, ok: true, result: r });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, ok: false, error: (err as Error).message });
  }
};
