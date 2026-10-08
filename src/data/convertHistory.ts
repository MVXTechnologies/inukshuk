/**
 * Convert's history (the app-bar clock): the last conversions as their
 * route params, on this device only (`convert-history.json`). A corrupt or
 * missing file reads as an empty history.
 */
import { File, Paths } from 'expo-file-system';
import { keepAlive } from '@data/keepAlive';

export interface HistoryEntry {
  at: number;
  /** "NAD83(CSRS) → MTM zone 7 · 81KM003" */
  title: string;
  params: Record<string, string>;
}

const NAME = 'convert-history.json';
export const HISTORY_MAX = 30;

function file(): File {
  return new File(Paths.document, NAME);
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const f = file();
    if (!f.exists) return [];
    const raw = JSON.parse(await keepAlive(f, f.text())) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (e): e is HistoryEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as HistoryEntry).title === 'string' &&
          typeof (e as HistoryEntry).at === 'number' &&
          !!(e as HistoryEntry).params,
      )
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

export function saveHistory(entries: readonly HistoryEntry[]): void {
  try {
    const f = file();
    if (f.exists) f.delete();
    f.create();
    f.write(JSON.stringify(entries.slice(0, HISTORY_MAX)));
  } catch {
    // History is a convenience: never let a write error reach the screen.
  }
}
