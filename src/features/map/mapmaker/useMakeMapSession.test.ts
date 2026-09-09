import type { BoundingBox, MapDocument } from '@core/models';
import { act, renderHook } from '@testing-library/react-native';
import type { ComposeHandle, ComposePhase, MakeMapOptions } from './composeMapPdf';
import { makeMap } from './makeMap';
import { useMakeMapSession } from './useMakeMapSession';

jest.mock('./makeMap', () => ({ makeMap: jest.fn() }));

type Progress = (phase: ComposePhase, frac: number) => void;

/** One deferred makeMap run the test settles by hand, plus what it was handed. */
function armMakeMap() {
  let resolve!: (doc: MapDocument) => void;
  let reject!: (err: unknown) => void;
  const run = { handle: null as ComposeHandle | null, progress: null as Progress | null };
  jest.mocked(makeMap).mockImplementationOnce((_bbox, _options, onProgress, handle) => {
    run.handle = handle;
    run.progress = onProgress;
    return new Promise<MapDocument>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  });
  return { run, resolve: (doc: MapDocument) => resolve(doc), reject: (e: unknown) => reject(e) };
}

const bboxA: BoundingBox = { minLng: -71.3, minLat: 46.7, maxLng: -71.1, maxLat: 46.9 };
const bboxB: BoundingBox = { minLng: -72, minLat: 45, maxLng: -71.9, maxLat: 45.1 };
const options = { name: 'Sheet' } as MakeMapOptions;
const doc = { name: 'Sheet' } as MapDocument;

async function setup() {
  const showSnack = jest.fn();
  const view = await renderHook(() => useMakeMapSession({ showSnack }));
  return { showSnack, view, state: () => view.result.current.makeMapState };
}

describe('useMakeMapSession (#309)', () => {
  it('a cancelled run does not clear the options sheet the user reopened', async () => {
    const first = armMakeMap();
    const { view, state, showSnack } = await setup();
    await act(async () => view.result.current.startMakeMap(bboxA, options));
    expect(state()).toMatchObject({ phase: 'generating' });

    await act(async () => view.result.current.cancelMakeMap());
    expect(first.run.handle?.aborted).toBe(true);
    expect(state()).toBeNull();
    // The user goes again with a different region; its sheet is open.
    await act(async () => view.result.current.setMakeMapState({ phase: 'options', bbox: bboxB }));

    // The first run notices the cancel and rejects — the sheet must survive,
    // and no "couldn't make the map" for a cancel the user asked for.
    await act(async () => {
      first.reject(new Error('aborted'));
    });
    expect(state()).toEqual({ phase: 'options', bbox: bboxB });
    expect(showSnack).not.toHaveBeenCalled();
    // ...nor may its late progress ticks touch the newer state.
    await act(async () => first.run.progress?.('compose', 0.5));
    expect(state()).toEqual({ phase: 'options', bbox: bboxB });
  });

  it('a superseded run never resets the run that replaced it, but a saved map is still announced', async () => {
    const first = armMakeMap();
    const second = armMakeMap();
    const { view, state, showSnack } = await setup();
    await act(async () => view.result.current.startMakeMap(bboxA, options));
    await act(async () => view.result.current.cancelMakeMap());
    await act(async () => view.result.current.startMakeMap(bboxB, options));
    expect(second.run.handle).not.toBe(first.run.handle);

    // The first run got past its last guard before Cancel: the doc IS in the library.
    await act(async () => {
      first.resolve({ ...doc, name: 'Late' });
    });
    expect(showSnack).toHaveBeenCalledWith('"Late" saved to the library');
    expect(state()).toMatchObject({ phase: 'generating', bbox: bboxB });

    await act(async () => second.run.progress?.('terrain', 0.4));
    expect(state()).toMatchObject({ progress: { phase: 'terrain', frac: 0.4 } });
    await act(async () => {
      second.resolve(doc);
    });
    expect(state()).toBeNull();
    expect(showSnack).toHaveBeenLastCalledWith('"Sheet" saved to the library');
  });

  it('a genuine failure of the current run reopens its options sheet with the message', async () => {
    const run = armMakeMap();
    const { view, state, showSnack } = await setup();
    await act(async () => view.result.current.startMakeMap(bboxA, options));
    await act(async () => {
      run.reject(new Error('tiles offline'));
    });
    expect(state()).toEqual({ phase: 'options', bbox: bboxA });
    expect(showSnack).toHaveBeenCalledWith("Couldn't make the map: tiles offline");
  });
});
