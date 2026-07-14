import { create } from 'zustand';

/**
 * Transient UI state for the manual error-report fallback: when no GitHub API
 * token is configured, the reporter asks the user (via a root-level dialog)
 * whether to open a pre-filled GitHub issue in the browser instead.
 */
export interface ManualErrorPrompt {
  /** Pre-filled `issues/new` URL for the newest queued report. */
  url: string;
  /** Fingerprint of the report the URL covers (dequeued once reported). */
  fingerprint: string;
  /** Total reports currently queued (shown in the dialog copy). */
  queuedCount: number;
}

interface ErrorPromptState {
  prompt: ManualErrorPrompt | null;
  show: (prompt: ManualErrorPrompt) => void;
  clear: () => void;
}

export const useErrorPromptStore = create<ErrorPromptState>((set) => ({
  prompt: null,
  show: (prompt) => set({ prompt }),
  clear: () => set({ prompt: null }),
}));
