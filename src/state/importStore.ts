import { IMPORT_SCHEMA_VERSION, sanitizeImportDoc, type ImportJob } from '@core/import/job';
import type { ActivitySourceId } from '@core/import/sources';
import * as storage from '@data/storage';
import { create } from 'zustand';

const IMPORTS_FILE = 'imports.json';

/** What the Import sheet opens on: a connected source, or the file picker. */
export type ImportSheetSource = ActivitySourceId | 'files';

/**
 * Connected-source imports (#432/#435): the one import job (running, paused
 * or just finished), each source's last finished import ("Since last
 * import"), and whether Health read access was granted — persisted to
 * `imports.json` so a paused or interrupted job survives the app closing.
 * The job's counters are pure data (`@core/import/job`); the importer that
 * drives them is `features/import/importController`.
 */
interface ImportState {
  hydrated: boolean;
  job: ImportJob | null;
  lastImportAt: Partial<Record<ActivitySourceId, number>>;
  healthAllowed: boolean;
  /**
   * A request to open the Library's Import sheet on a source (Settings ›
   * Connections → "Import activities"). Session-only; the Library consumes it.
   */
  sheetRequest: { source: ImportSheetSource | null } | null;

  hydrate: () => Promise<void>;
  /**
   * Replace the job. `persist: false` for per-activity progress ticks (the
   * importer persists at its flush points, together with the Library write).
   */
  setJob: (job: ImportJob | null, options?: { persist?: boolean }) => void;
  /** Record a finished import of `source` that began at `at`. */
  markImported: (source: ActivitySourceId, at: number) => void;
  setHealthAllowed: (allowed: boolean) => void;
  requestSheet: (source: ImportSheetSource | null) => void;
  clearSheetRequest: () => void;
}

function persist(state: Pick<ImportState, 'job' | 'lastImportAt' | 'healthAllowed'>): void {
  storage.writeJson(IMPORTS_FILE, {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    job: state.job,
    lastImportAt: state.lastImportAt,
    healthAllowed: state.healthAllowed,
  });
}

export const useImportStore = create<ImportState>((set, get) => ({
  hydrated: false,
  job: null,
  lastImportAt: {},
  healthAllowed: false,
  sheetRequest: null,

  hydrate: async () => {
    const saved = await storage.readJson<unknown>(IMPORTS_FILE);
    // A job this session already started wins over what was on disk.
    const current = get().job;
    const doc = sanitizeImportDoc(saved);
    set({ ...doc, job: current ?? doc.job, hydrated: true });
  },

  setJob: (job, options) => {
    set({ job });
    if (options?.persist !== false) persist({ ...get(), job });
  },

  markImported: (source, at) => {
    const lastImportAt = { ...get().lastImportAt, [source]: at };
    set({ lastImportAt });
    persist({ ...get(), lastImportAt });
  },

  setHealthAllowed: (allowed) => {
    set({ healthAllowed: allowed });
    persist({ ...get(), healthAllowed: allowed });
  },

  requestSheet: (source) => set({ sheetRequest: { source } }),
  clearSheetRequest: () => set({ sheetRequest: null }),
}));
