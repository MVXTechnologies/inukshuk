/**
 * How many times a PDF page's render must be cut short by the app process
 * ending before the page is paused as a crash risk.
 *
 * The render checkpoint (`@data/pdfRenderRecovery`) cannot tell a crash from
 * any other end of the process: the user swiping the app away, the OS
 * reclaiming a backgrounded or suspended app, `am force-stop` (which every
 * Maestro `launchApp` does). Pausing on the first strike turned each of those
 * into "Rendering was interrupted… turned off" for a page that renders fine.
 * A page that really kills the app does so on every attempt, so it is paused
 * on the second consecutive interruption; any render of the page that ends
 * with the process still alive clears its strikes.
 */
export const INTERRUPTIONS_BEFORE_PAUSE = 2;

/** At most this many pages are remembered; the oldest strike is dropped first. */
export const MAX_INTERRUPTION_ENTRIES = 8;

export interface RenderInterruption {
  /** Document-relative PDF path. */
  filePath: string;
  pageIndex: number;
  /** Consecutive interrupted renders of this page with no completed render between. */
  count: number;
  /** Checkpoint token of the last counted interruption, so a recount is a no-op. */
  token: string;
}

export interface InterruptedPage {
  filePath: string;
  pageIndex: number;
  token: string;
}

interface PageRef {
  filePath: string;
  pageIndex: number;
}

function samePage(a: PageRef, b: PageRef): boolean {
  return a.filePath === b.filePath && a.pageIndex === b.pageIndex;
}

/**
 * Count one interrupted render. Counting the same checkpoint token twice (the
 * process died again before the checkpoint was consumed) does not add a strike.
 * Returns the updated, bounded list (most recent last) and whether to pause.
 */
export function recordInterruption(
  entries: readonly RenderInterruption[],
  page: InterruptedPage,
): { entries: RenderInterruption[]; pause: boolean } {
  const previous = entries.find((entry) => samePage(entry, page));
  const count =
    previous === undefined
      ? 1
      : previous.token === page.token
        ? previous.count
        : previous.count + 1;
  const updated: RenderInterruption = {
    filePath: page.filePath,
    pageIndex: page.pageIndex,
    count,
    token: page.token,
  };
  const others = entries.filter((entry) => !samePage(entry, page));
  return {
    entries: [...others, updated].slice(-MAX_INTERRUPTION_ENTRIES),
    pause: count >= INTERRUPTIONS_BEFORE_PAUSE,
  };
}

/** A render of this page ended with the process alive: forget its strikes. */
export function clearInterruptions(
  entries: readonly RenderInterruption[],
  page: { filePath: string; pageIndex: number },
): RenderInterruption[] {
  return entries.filter((entry) => !samePage(entry, page));
}

/** Validate a stored list; anything malformed is dropped, never thrown. */
export function parseInterruptions(value: unknown): RenderInterruption[] {
  if (!value || typeof value !== 'object') return [];
  const list = (value as { entries?: unknown }).entries;
  if (!Array.isArray(list)) return [];
  const valid: RenderInterruption[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Partial<RenderInterruption>;
    if (
      typeof entry.filePath === 'string' &&
      entry.filePath.length > 0 &&
      entry.filePath.length <= 4096 &&
      typeof entry.pageIndex === 'number' &&
      Number.isSafeInteger(entry.pageIndex) &&
      entry.pageIndex >= 0 &&
      typeof entry.count === 'number' &&
      Number.isSafeInteger(entry.count) &&
      entry.count >= 1 &&
      typeof entry.token === 'string' &&
      entry.token.length > 0 &&
      entry.token.length <= 128
    ) {
      const page = { filePath: entry.filePath, pageIndex: entry.pageIndex };
      const kept = valid.filter((existing) => !samePage(page, existing));
      valid.length = 0;
      valid.push(...kept, {
        filePath: entry.filePath,
        pageIndex: entry.pageIndex,
        count: entry.count,
        token: entry.token,
      });
    }
  }
  return valid.slice(-MAX_INTERRUPTION_ENTRIES);
}
