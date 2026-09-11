import type { WaypointIcon } from '@core/models';
import * as storage from '@data/storage';

/**
 * A standalone waypoint the editor is composing that does NOT exist yet
 * (#232): created on Done. Until then the draft is the only owner of any photo
 * the editor has already copied into app storage, so every way out of the
 * draft — replacing or removing the photo, discarding the draft — must also
 * settle that file (#306). Done hands ownership to the library store.
 */
export interface WaypointDraft {
  latitude: number;
  longitude: number;
  /** Absolute file:// uri of a photo already copied into app storage. */
  photoUri?: string;
  /** Chosen pin icon (#350); absent = the default pin. Saved on Done. */
  icon?: WaypointIcon;
}

function discard(uri: string | undefined): void {
  if (!uri) return;
  try {
    storage.deleteFileAt(uri);
  } catch {
    // The draft no longer references it; an orphan beats failing the action.
  }
}

/**
 * Apply the editor's photo change to a draft: a uri attaches (replacing any
 * earlier photo), `''` removes — the `photoUri` field is dropped outright, not
 * left behind for Done to save. The previous copy, which only the draft
 * owned, is deleted.
 */
export function withDraftPhoto(draft: WaypointDraft, uri: string): WaypointDraft {
  const { photoUri: previous, ...rest } = draft;
  if (previous !== undefined && previous !== uri) discard(previous);
  return uri ? { ...rest, photoUri: uri } : rest;
}

/** Abandon a draft without creating a waypoint: its photo copy has no owner left. */
export function discardDraftPhoto(draft: WaypointDraft | null): void {
  discard(draft?.photoUri);
}
