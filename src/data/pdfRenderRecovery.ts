import { File, Paths } from 'expo-file-system';
import { nanoid } from 'nanoid/non-secure';
import {
  isAbsolutePath,
  joinDocumentPath,
  toDocumentRelativePath,
} from '@core/storage/documentPaths';
import {
  clearInterruptions,
  parseInterruptions,
  recordInterruption,
  type RenderInterruption,
} from '@core/library/renderInterruptions';

export interface InterruptedPdfRender {
  token: string;
  fileUri: string;
  pageIndex: number;
}

// Document root is outside the loopback server's served-path allowlist.
const CHECKPOINT = '.pdf-render-checkpoint.json';
const STAGE = `${CHECKPOINT}.tmp`;
const MAX_BYTES = 8192;
// Consecutive interruptions per page (see `@core/library/renderInterruptions`).
const STRIKES = '.pdf-render-interruptions.json';
const MAX_STRIKE_BYTES = 65536;
let strikesCache: RenderInterruption[] | null = null;
// A failed library save leaves the original page active on disk. No subsequent
// render may replace its recovery evidence until that pause is acknowledged.
let protectedToken: string | null = null;
interface StoredCheckpoint {
  version: 1;
  token: string;
  filePath: string;
  pageIndex: number;
}
function validPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 4096 || isAbsolutePath(path)) return false;
  try {
    const decoded = decodeURIComponent(path);
    return (
      !/[\\\0?#]/.test(decoded) &&
      decoded.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
    );
  } catch {
    return false;
  }
}
function validPage(index: unknown): index is number {
  return typeof index === 'number' && Number.isSafeInteger(index) && index >= 0;
}
function readFile(name: string): StoredCheckpoint | null {
  try {
    const file = new File(Paths.document, name);
    if (!file.exists || file.size > MAX_BYTES) return null;
    const value: unknown = JSON.parse(file.textSync());
    if (!value || typeof value !== 'object') return null;
    const data = value as Partial<StoredCheckpoint>;
    if (
      data.version !== 1 ||
      typeof data.token !== 'string' ||
      !data.token ||
      data.token.length > 128 ||
      !validPath(data.filePath) ||
      !validPage(data.pageIndex)
    )
      return null;
    return { version: 1, token: data.token, filePath: data.filePath, pageIndex: data.pageIndex };
  } catch {
    return null;
  }
}

/** Synchronous commit: a failed write throws, so callers must not start rendering. */
export function beginPdfRender(input: { fileUri: string; pageIndex: number }): string {
  if (protectedToken !== null)
    throw new Error('Could not save map recovery. Free storage and restart the app.');
  const filePath = toDocumentRelativePath(input.fileUri, Paths.document.uri);
  if (!validPath(filePath) || !validPage(input.pageIndex))
    throw new Error('Invalid PDF render checkpoint');
  const token = nanoid();
  const payload: StoredCheckpoint = { version: 1, token, filePath, pageIndex: input.pageIndex };
  const text = JSON.stringify(payload);
  // Bound the actual encoded payload as well as individual fields.
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    throw new Error('PDF render checkpoint is too large');
  const staged = new File(Paths.document, STAGE);
  if (staged.exists) staged.delete();
  staged.create();
  staged.write(text);
  const file = new File(Paths.document, CHECKPOINT);
  if (file.exists) file.delete();
  // Expo's replacement removes then renames. A complete fixed staging file
  // remains recoverable if the process dies in that gap. No accumulating temp files.
  staged.moveSync(file);
  return token;
}

/** Also recovers the completed stage if interrupted between removal and rename. */
export function readInterruptedPdfRender(): InterruptedPdfRender | null {
  const data = readFile(CHECKPOINT) ?? readFile(STAGE);
  return data
    ? {
        token: data.token,
        fileUri: joinDocumentPath(Paths.document.uri, data.filePath),
        pageIndex: data.pageIndex,
      }
    : null;
}

/**
 * A late completion cannot acknowledge a newer render, including its staging file.
 * The process outlived this render, so the page's interruption strikes are cleared.
 */
export function finishPdfRender(token: string): void {
  if (protectedToken === token) return;
  const page = clearMatchingCheckpoint(token);
  if (page) clearStrikes(page);
}

function clearMatchingCheckpoint(token: string): StoredCheckpoint | null {
  let matched: StoredCheckpoint | null = null;
  for (const name of [CHECKPOINT, STAGE]) {
    const data = readFile(name);
    if (data?.token === token) {
      new File(Paths.document, name).delete();
      matched = data;
    }
  }
  return matched;
}

function loadStrikes(): RenderInterruption[] {
  if (strikesCache !== null) return strikesCache;
  let entries: RenderInterruption[] = [];
  try {
    const file = new File(Paths.document, STRIKES);
    if (file.exists && file.size <= MAX_STRIKE_BYTES) {
      entries = parseInterruptions(JSON.parse(file.textSync()));
    }
  } catch {
    entries = [];
  }
  strikesCache = entries;
  return entries;
}

/** Throws when the list cannot be written; the cache only changes on success. */
function saveStrikes(entries: RenderInterruption[]): void {
  const file = new File(Paths.document, STRIKES);
  if (entries.length === 0) {
    if (file.exists) file.delete();
  } else {
    if (!file.exists) file.create();
    file.write(JSON.stringify({ version: 1, entries }));
  }
  strikesCache = entries;
}

function clearStrikes(page: { filePath: string; pageIndex: number }): void {
  const entries = loadStrikes();
  const remaining = clearInterruptions(entries, page);
  if (remaining.length !== entries.length) saveStrikes(remaining);
}

/**
 * Count the interrupted render found at launch against its page and say
 * whether to pause the page now. The first interruption of a page is most
 * often the process being ended from outside (swiped away, reclaimed by the
 * OS, force-stopped), not a crash, so the page gets one more attempt; a page
 * that ends the process again before any render of it completes is paused.
 * The strike is saved before returning, so the caller may consume the
 * checkpoint afterwards. Throws when it cannot be saved: pause then.
 */
export function recordPdfRenderInterruption(interrupted: InterruptedPdfRender): boolean {
  const filePath = toDocumentRelativePath(interrupted.fileUri, Paths.document.uri);
  const { entries, pause } = recordInterruption(loadStrikes(), {
    filePath,
    pageIndex: interrupted.pageIndex,
    token: interrupted.token,
  });
  saveStrikes(entries);
  return pause;
}

/** Preserve crash evidence when the safe library state could not be saved. */
export function protectInterruptedPdfRender(token: string): void {
  protectedToken = token;
}

/** Called only after the restored library no longer automatically renders this page. */
export function clearInterruptedPdfRender(token: string): void {
  clearMatchingCheckpoint(token);
  if (protectedToken === token) protectedToken = null;
}
