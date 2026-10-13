import { isWaypointSize, normalizeWaypointColor } from '@core/library/waypointStyle';
import type { WaypointIcon, WaypointSize } from '@core/models';
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
  /** Pin colour and size (#675); absent = the defaults. Saved on Done. */
  color?: string;
  size?: WaypointSize;
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

/** Apply the editor's colour / size change to a draft; `null` clears a field. */
export function withDraftStyle(
  draft: WaypointDraft,
  patch: { color?: string | null; size?: WaypointSize | null },
): WaypointDraft {
  const { color: oldColor, size: oldSize, ...rest } = draft;
  const color = patch.color === undefined ? oldColor : normalizeWaypointColor(patch.color);
  const size =
    patch.size === undefined ? oldSize : isWaypointSize(patch.size) ? patch.size : undefined;
  return {
    ...rest,
    ...(color !== undefined ? { color } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}
