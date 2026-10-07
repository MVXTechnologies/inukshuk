/**
 * What a PDF render does when the OS kills the rasterizer's WebView content
 * process under it (#323): iOS `webViewWebContentProcessDidTerminate`,
 * Android `onRenderProcessGone`.
 *
 * The app survives this — only the WebView's helper process died — so it is
 * not the app-process interruption `renderInterruptions` counts, but the
 * question is the same: is the PAGE at fault? A page that really exhausts the
 * content process does so on every attempt; iOS also reclaims that process
 * for reasons that have nothing to do with the page — the app went to the
 * background, or memory was tight elsewhere. Pausing the page on the first
 * termination (what the field saw 11 times) turned a map off that renders
 * fine.
 *
 * So, like `renderInterruptions`, a page gets a second chance: the first
 * termination of a render re-queues it. A second termination of the same
 * render while the app is in front is the page's fault (it is paused, as
 * before); one in the background or right after a resume is not ("not
 * started": the caller retries later and the page stays on). The app phase
 * travels in the error message, so field reports say which case they are.
 */

/** How long after coming back to the foreground a termination still counts as the resume's. */
export const RESUME_GRACE_MS = 10_000;

/** Where the app was when the content process died. */
export type AppPhase = 'active' | 'background' | 'resuming';

export interface AppPhaseInput {
  /** AppState is `active`. */
  foreground: boolean;
  /** When the app last came back to the foreground; null if it has not left it. */
  activeSince: number | null;
}

export function appPhaseAt(input: AppPhaseInput, now: number): AppPhase {
  if (!input.foreground) return 'background';
  if (input.activeSince !== null && now - input.activeSince < RESUME_GRACE_MS) return 'resuming';
  return 'active';
}

/**
 * - `retry`: re-queue the render (the first termination of this render);
 * - `page-failure`: reject as a render failure — the page is paused;
 * - `not-started`: reject as not started — the page stays on, retried later.
 */
export type TerminationVerdict = 'retry' | 'page-failure' | 'not-started';

/**
 * The verdict for a termination at `phase`. `firstPhase` is where the app was
 * at this render's earlier termination, or null if this is its first.
 */
export function terminationVerdict(
  phase: AppPhase,
  firstPhase: AppPhase | null,
): TerminationVerdict {
  if (firstPhase === null) return 'retry';
  return phase === 'active' ? 'page-failure' : 'not-started';
}

/** The rejection message: the field report's title, with both app phases. */
export function terminationMessage(firstPhase: AppPhase, phase: AppPhase): string {
  return `PdfRasterizer: rendering process terminated twice (app ${firstPhase}, then ${phase})`;
}
