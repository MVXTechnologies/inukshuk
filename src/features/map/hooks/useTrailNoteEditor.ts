import * as storage from '@data/storage';
import { useCallback, useRef, useState } from 'react';

/** What the trail viewer's note dialog is editing: a new note at a distance, or an existing one. */
export type NoteEditing = { mode: 'add'; distanceM: number } | { mode: 'edit'; noteId: string };

export interface TrailNoteStore {
  addTrackNote: (trackId: string, distanceM: number, text: string, photoUri?: string) => string;
  updateTrackNote: (
    trackId: string,
    noteId: string,
    text: string,
    photoUri?: string | null,
  ) => void;
}

interface Options extends TrailNoteStore {
  trackId: string;
  /** The photo the note being edited already has, so "unchanged" is not re-imported. */
  existingPhotoOf: (noteId: string) => string | undefined;
  /** A save failed; the draft, photo and dialog are all still there for another try. */
  onError: (err: unknown) => void;
}

interface Submission {
  trackId: string;
  editing: NoteEditing;
  text: string;
  /** The dialog's photo: a picker temp uri (new), the stored uri (kept) or null (none). */
  draftPhoto: string | null;
}

/**
 * Persist one note edit: copy a newly picked photo into app storage, then
 * commit to the store. A store failure after the copy deletes the copy again
 * so a note that never landed leaves no orphan photo behind (#307).
 */
export async function persistTrailNote(
  { trackId, editing, text, draftPhoto }: Submission,
  store: TrailNoteStore & Pick<Options, 'existingPhotoOf'>,
): Promise<void> {
  let imported: string | undefined;
  try {
    if (editing.mode === 'add') {
      if (draftPhoto) imported = await storage.importPhoto(draftPhoto, storage.newId());
      store.addTrackNote(trackId, editing.distanceM, text, imported);
      return;
    }
    const existing = store.existingPhotoOf(editing.noteId);
    let photo: string | null | undefined;
    if ((draftPhoto ?? undefined) === existing) photo = undefined;
    else if (!draftPhoto) photo = null;
    else photo = imported = await storage.importPhoto(draftPhoto, storage.newId());
    store.updateTrackNote(trackId, editing.noteId, text, photo);
  } catch (err) {
    if (imported) {
      try {
        storage.deleteFileAt(imported);
      } catch {
        // The real failure is the one to surface.
      }
    }
    throw err;
  }
}

/**
 * State + commit for the trail viewer's note dialog (#307).
 *
 * - A failed save (photo copy or store) reports through `onError` and keeps
 *   `editing`, `draft` and `draftPhoto` exactly as they were: the dialog stays
 *   open with the user's text. Nothing is cleared until one save succeeds.
 * - `commit` is single-flight: while a save is in progress (`saving`), further
 *   taps are ignored, so a slow photo copy can't produce two notes.
 * - A completion only clears the editor it was started from. Opening or
 *   closing the editor bumps a session token; a save that finishes after that
 *   leaves the newer editor alone.
 * - `close` is refused while saving, for the same reason.
 */
export function useTrailNoteEditor(options: Options) {
  const [editing, setEditingState] = useState<NoteEditing | null>(null);
  const [draft, setDraft] = useState('');
  const [draftPhoto, setDraftPhoto] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const session = useRef(0);

  const setEditing = useCallback((next: NoteEditing | null) => {
    session.current += 1;
    setEditingState(next);
  }, []);

  const close = useCallback(() => {
    if (inFlight.current) return;
    setEditing(null);
  }, [setEditing]);

  const commit = useCallback(async () => {
    const text = draft.trim();
    if (!editing || !text) {
      close();
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    const mine = session.current;
    const { trackId, existingPhotoOf, addTrackNote, updateTrackNote, onError } = options;
    try {
      await persistTrailNote(
        { trackId, editing, text, draftPhoto },
        { existingPhotoOf, addTrackNote, updateTrackNote },
      );
    } catch (err) {
      onError(err);
      return;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
    if (session.current !== mine) return;
    setEditing(null);
    setDraft('');
    setDraftPhoto(null);
  }, [draft, editing, draftPhoto, options, close, setEditing]);

  return { editing, setEditing, draft, setDraft, draftPhoto, setDraftPhoto, saving, commit, close };
}
