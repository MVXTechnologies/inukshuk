/**
 * Share live in the screens (#712): the shared folders, re-read whenever the
 * library bridge finishes a pass (it runs on every Library or group change).
 */
import type { LocalKind } from '@core/domains/library/liveFields';
import { appLibraryBridge, appLiveFolders } from '@data/sync/libraryPort';
import type { LiveFolder, LiveFolders } from '@data/sync/liveFolders';
import { useSyncExternalStore } from 'react';

let cache: { version: number; list: LiveFolder[] } = { version: -1, list: [] };
let version = 0;
const listeners = new Set<() => void>();
let wired = false;

function wire(): void {
  if (wired) return;
  const bridge = appLibraryBridge();
  if (bridge === null) return;
  wired = true;
  bridge.subscribe(() => {
    version++;
    for (const l of [...listeners]) l();
  });
}

function subscribe(l: () => void): () => void {
  wire();
  listeners.add(l);
  return () => listeners.delete(l);
}

function snapshot(): LiveFolder[] {
  if (cache.version !== version) {
    let list: LiveFolder[] = [];
    try {
      list = appLiveFolders()?.list() ?? [];
    } catch {
      list = [];
    }
    cache = { version, list };
  }
  return cache.list;
}

/** Re-read now (after an action the screens did themselves). */
export function refreshLive(): void {
  version++;
  for (const l of [...listeners]) l();
}

/** Every shared folder and item on this phone, joined or joining. */
export function useLiveFolders(): LiveFolder[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The app's live folders service (actions), or null without team mode. */
export function liveService(): LiveFolders | null {
  return appLiveFolders();
}

/** The share a Library folder or item is the root of, if any. */
export function rootShare(list: readonly LiveFolder[], kind: LocalKind, id: string) {
  return list.find((f) => f.local?.kind === kind && f.local.id === id);
}

/** The note a row inside a shared folder gets ("Renamed by Julie · 2 h"), if any. */
export function rowNoteOf(list: readonly LiveFolder[], kind: LocalKind, id: string) {
  for (const f of list) {
    const n = f.notes.get(`${kind}:${id}`);
    if (n !== undefined) return n;
  }
  return undefined;
}
