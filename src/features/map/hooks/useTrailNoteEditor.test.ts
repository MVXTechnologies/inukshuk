import * as storage from '@data/storage';
import { act, renderHook } from '@testing-library/react-native';
import { useTrailNoteEditor } from './useTrailNoteEditor';

jest.mock('@data/storage', () => ({
  newId: () => 'photo-id',
  importPhoto: jest.fn(),
  deleteFileAt: jest.fn(),
}));

/** A promise the test settles by hand, standing in for a slow photo copy. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function setup(existing?: string) {
  const store = {
    addTrackNote: jest.fn(() => 'note-id'),
    updateTrackNote: jest.fn(),
    existingPhotoOf: jest.fn(() => existing),
    onError: jest.fn(),
  };
  const view = await renderHook(() => useTrailNoteEditor({ trackId: 't1', ...store }));
  const open = async (
    editing: Parameters<typeof view.result.current.setEditing>[0],
    draft: string,
    photo: string | null,
  ) => {
    await act(async () => {
      view.result.current.setEditing(editing);
      view.result.current.setDraft(draft);
      view.result.current.setDraftPhoto(photo);
    });
  };
  const commit = () => act(async () => view.result.current.commit());
  return { store, view, open, commit };
}

describe('useTrailNoteEditor (#307)', () => {
  it('a failed photo copy keeps the editor, draft and photo for another try', async () => {
    jest.mocked(storage.importPhoto).mockRejectedValue(new Error('disk full'));
    const { store, view, open, commit } = await setup();
    await open({ mode: 'add', distanceM: 120 }, 'Cairn at the fork', 'file:///tmp/pick.jpg');

    await commit();

    expect(store.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
    expect(view.result.current.editing).toEqual({ mode: 'add', distanceM: 120 });
    expect(view.result.current.draft).toBe('Cairn at the fork');
    expect(view.result.current.draftPhoto).toBe('file:///tmp/pick.jpg');
    expect(view.result.current.saving).toBe(false);
    expect(store.addTrackNote).not.toHaveBeenCalled();
  });

  it('a store failure after the copy deletes the fresh copy and keeps the draft', async () => {
    jest.mocked(storage.importPhoto).mockResolvedValue('file:///doc/photos/photo-id.jpg');
    const { store, view, open, commit } = await setup();
    store.addTrackNote.mockImplementation(() => {
      throw new Error('index write failed');
    });
    await open({ mode: 'add', distanceM: 5 }, 'text', 'file:///tmp/pick.jpg');

    await commit();

    expect(storage.deleteFileAt).toHaveBeenCalledWith('file:///doc/photos/photo-id.jpg');
    expect(store.onError).toHaveBeenCalledTimes(1);
    expect(view.result.current.editing).not.toBeNull();
    expect(view.result.current.draft).toBe('text');
  });

  it('is single-flight: two Save taps during one photo copy add ONE note', async () => {
    const copy = deferred<string>();
    jest.mocked(storage.importPhoto).mockReturnValue(copy.promise);
    const { store, view, open } = await setup();
    await open({ mode: 'add', distanceM: 5 }, 'once', 'file:///tmp/pick.jpg');

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = view.result.current.commit();
      second = view.result.current.commit();
    });
    expect(view.result.current.saving).toBe(true);
    // Cancel is refused mid-save too — the dialog can't vanish under a save.
    await act(async () => view.result.current.close());
    expect(view.result.current.editing).not.toBeNull();

    await act(async () => {
      copy.resolve('file:///doc/photos/photo-id.jpg');
      await Promise.all([first, second]);
    });
    expect(storage.importPhoto).toHaveBeenCalledTimes(1);
    expect(store.addTrackNote).toHaveBeenCalledTimes(1);
    expect(store.addTrackNote).toHaveBeenCalledWith(
      't1',
      5,
      'once',
      'file:///doc/photos/photo-id.jpg',
    );
    // One successful save is what clears the editor.
    expect(view.result.current.editing).toBeNull();
    expect(view.result.current.draft).toBe('');
    expect(view.result.current.draftPhoto).toBeNull();
    expect(view.result.current.saving).toBe(false);
  });

  it('a completion never clears an editor opened after it started', async () => {
    const copy = deferred<string>();
    jest.mocked(storage.importPhoto).mockReturnValue(copy.promise);
    const { store, view, open } = await setup();
    await open({ mode: 'add', distanceM: 5 }, 'old', 'file:///tmp/pick.jpg');
    let pending!: Promise<void>;
    await act(async () => {
      pending = view.result.current.commit();
    });
    // A newer editing session (the screen re-opened the dialog for another note).
    await open({ mode: 'edit', noteId: 'n9' }, 'newer text', null);

    await act(async () => {
      copy.resolve('file:///doc/photos/photo-id.jpg');
      await pending;
    });
    expect(store.addTrackNote).toHaveBeenCalledTimes(1);
    expect(view.result.current.editing).toEqual({ mode: 'edit', noteId: 'n9' });
    expect(view.result.current.draft).toBe('newer text');
  });

  it('edit mode: unchanged photo is not re-imported, removal passes null, replacement imports', async () => {
    jest.mocked(storage.importPhoto).mockResolvedValue('file:///doc/photos/photo-id.jpg');
    const { store, open, commit } = await setup('file:///doc/photos/kept.jpg');

    await open({ mode: 'edit', noteId: 'n1' }, 'same photo', 'file:///doc/photos/kept.jpg');
    await commit();
    expect(store.updateTrackNote).toHaveBeenLastCalledWith('t1', 'n1', 'same photo', undefined);

    await open({ mode: 'edit', noteId: 'n1' }, 'no photo', null);
    await commit();
    expect(store.updateTrackNote).toHaveBeenLastCalledWith('t1', 'n1', 'no photo', null);

    await open({ mode: 'edit', noteId: 'n1' }, 'new photo', 'file:///tmp/other.jpg');
    await commit();
    expect(store.updateTrackNote).toHaveBeenLastCalledWith(
      't1',
      'n1',
      'new photo',
      'file:///doc/photos/photo-id.jpg',
    );
    expect(storage.importPhoto).toHaveBeenCalledTimes(1);
  });

  it('a blank draft just closes without touching the store', async () => {
    const { store, view, open, commit } = await setup();
    await open({ mode: 'add', distanceM: 5 }, '   ', null);
    await commit();
    expect(view.result.current.editing).toBeNull();
    expect(store.addTrackNote).not.toHaveBeenCalled();
  });
});
