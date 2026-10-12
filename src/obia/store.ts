// Checkpoints of the OBIA project in IndexedDB (typed arrays stored as they
// are), so a reload — or a tablet that suspended the tab — resumes from the
// last saved stage. Work in progress is NOT continued in the background: a
// job interrupted by a reload is simply not in the checkpoint, and says so.
// Storage use and quota failures are reported, never swallowed.

import type { ObiaProject } from './project.ts';

const DB = 'stac-viewer-obia', STORE = 'projects', KEY = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB is unavailable'));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error);
      t.onabort = () => reject(t.error ?? new Error('the save was aborted'));
    });
  } finally { db.close(); }
}

export async function saveProject(p: ObiaProject): Promise<void> {
  try { await tx('readwrite', s => s.put(p, KEY)); }
  catch (e) {
    const name = (e as DOMException)?.name;
    throw new Error(name === 'QuotaExceededError' ? 'the browser refused the save: storage quota exceeded. Export the project bundle, then clear it here.' : `could not save the project: ${(e as Error)?.message ?? e}`);
  }
}

export const loadProject = () => tx<ObiaProject | undefined>('readonly', s => s.get(KEY) as IDBRequest<ObiaProject | undefined>);
export const clearProject = () => tx('readwrite', s => s.delete(KEY));

export async function storageReport(): Promise<string> {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  if (!est) return 'Storage use is not reported by this browser.';
  const mb = (b?: number) => (b === undefined ? '?' : `${(b / 1024 ** 2).toFixed(0)} MB`);
  return `This site uses ${mb(est.usage)} of ${mb(est.quota)} available. ${persisted ? 'Storage is persistent.' : 'Storage is NOT marked persistent: the browser may evict it under pressure — export the bundle to keep work.'}`;
}

export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.().catch(() => false)) ?? false;
}
