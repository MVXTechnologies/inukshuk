import * as recovery from '@data/pdfRenderRecovery';
import * as storage from '@data/storage';
import { useLibraryStore } from './libraryStore';

jest.mock('@data/pdfRenderRecovery', () => ({
  readInterruptedPdfRender: jest.fn(() => null),
  clearInterruptedPdfRender: jest.fn(),
  protectInterruptedPdfRender: jest.fn(),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  ensureStorage: jest.fn(),
  readIndex: jest.fn(),
  writeIndex: jest.fn(),
  deleteFileAt: jest.fn(),
}));

const index = () => ({
  schemaVersion: 5,
  maps: ['large', 'working'].map((id) => ({
    id,
    name: id,
    fileUri: `maps/${id}.pdf`,
    importedAt: 1,
    pageCount: 2,
    georeferences: [],
    activePages: id === 'large' ? [0, 1] : [0],
  })),
  tracks: [],
  folders: [],
  activeMapId: 'working',
  activeTrackIds: [],
});

beforeEach(() => {
  useLibraryStore.setState({ hydrated: false, maps: [] });
  jest.mocked(storage.readIndex).mockResolvedValue(index());
  jest.mocked(storage.writeIndex).mockImplementation(() => undefined);
  jest.mocked(recovery.readInterruptedPdfRender).mockReturnValue({
    token: 'interrupted',
    fileUri: 'file:///doc/maps/large.pdf',
    pageIndex: 1,
  });
});

it('pauses only the interrupted page before publishing the restored library', async () => {
  const exposed: number[][] = [];
  const unsub = useLibraryStore.subscribe((s) => {
    if (s.hydrated) exposed.push(s.maps.find((m) => m.id === 'large')?.activePages ?? []);
  });
  await useLibraryStore.getState().hydrate();
  unsub();
  expect(exposed).toEqual([[0]]);
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'working')?.activePages).toEqual([0]);
  expect(storage.writeIndex).toHaveBeenCalledWith(
    expect.objectContaining({
      maps: expect.arrayContaining([expect.objectContaining({ id: 'large', activePages: [0] })]),
    }),
  );
  expect(recovery.clearInterruptedPdfRender).toHaveBeenCalledWith('interrupted');
  expect(jest.mocked(storage.writeIndex).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(recovery.clearInterruptedPdfRender).mock.invocationCallOrder[0]!,
  );
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
  expect(useLibraryStore.getState().pdfRecoveryNotice).toContain('page 2');
  expect(useLibraryStore.getState().pdfRecoveryNotice).toContain('large');
});

it('keeps the page paused in memory and retains recovery evidence if saving fails', async () => {
  const protectionAtPublish: boolean[] = [];
  const unsub = useLibraryStore.subscribe((s) => {
    if (s.hydrated)
      protectionAtPublish.push(
        jest.mocked(recovery.protectInterruptedPdfRender).mock.calls.length > 0,
      );
  });
  jest.mocked(storage.writeIndex).mockImplementation(() => {
    throw new Error('ENOSPC');
  });
  await expect(useLibraryStore.getState().hydrate()).resolves.toBeUndefined();
  unsub();
  expect(protectionAtPublish).toEqual([true]);
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'large')?.activePages).toEqual([0]);
  expect(recovery.clearInterruptedPdfRender).not.toHaveBeenCalled();
  expect(recovery.protectInterruptedPdfRender).toHaveBeenCalledWith('interrupted');
});

it('allows an explicit page toggle to retry without deleting or reimporting the PDF', async () => {
  await useLibraryStore.getState().hydrate();
  useLibraryStore.getState().toggleMapPage('large', 1);
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'large')?.activePages).toEqual([
    0, 1,
  ]);
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it('does not alter or rewrite the library after a successful rendering session', async () => {
  jest.mocked(recovery.readInterruptedPdfRender).mockReturnValue(null);
  await useLibraryStore.getState().hydrate();
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'large')?.activePages).toEqual([
    0, 1,
  ]);
  expect(storage.writeIndex).not.toHaveBeenCalled();
});

it('preserves the unticked interrupted-page error through a second launch', async () => {
  await useLibraryStore.getState().hydrate();
  const saved = jest.mocked(storage.writeIndex).mock.calls[0]![0];
  expect(
    useLibraryStore.getState().maps.find((m) => m.id === 'large')?.renderRecoveryErrors,
  ).toEqual([{ pageIndex: 1, reason: 'interrupted' }]);
  useLibraryStore.setState({ hydrated: false, maps: [] });
  jest.mocked(recovery.readInterruptedPdfRender).mockReturnValue(null);
  jest.mocked(storage.readIndex).mockResolvedValue(JSON.parse(JSON.stringify(saved)));
  await useLibraryStore.getState().hydrate();
  const restored = useLibraryStore.getState().maps.find((m) => m.id === 'large');
  expect(restored?.activePages).toEqual([0]);
  expect(restored?.renderRecoveryErrors).toEqual([{ pageIndex: 1, reason: 'interrupted' }]);
});

it('explicit retry clears only its page error and activates only that page in one saved update', async () => {
  await useLibraryStore.getState().hydrate();
  useLibraryStore.setState((s) => ({
    maps: s.maps.map((m) =>
      m.id === 'large'
        ? {
            ...m,
            activePages: [],
            renderRecoveryErrors: [
              { pageIndex: 0, reason: 'interrupted' as const },
              { pageIndex: 1, reason: 'interrupted' as const },
            ],
          }
        : m,
    ),
  }));
  jest.mocked(storage.writeIndex).mockClear();
  const published: unknown[] = [];
  const unsubscribe = useLibraryStore.subscribe((s) =>
    published.push(s.maps.find((m) => m.id === 'large')),
  );
  useLibraryStore.getState().retryMapPage('large', 1);
  unsubscribe();
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    activePages: [1],
    renderRecoveryErrors: [{ pageIndex: 0, reason: 'interrupted' }],
  });
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'working')?.activePages).toEqual([0]);
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it('keeps the recovery error and page unticked if explicit retry cannot be saved', async () => {
  await useLibraryStore.getState().hydrate();
  jest.mocked(storage.writeIndex).mockImplementationOnce(() => {
    throw new Error('ENOSPC');
  });
  jest.mocked(recovery.clearInterruptedPdfRender).mockClear();
  expect(() => useLibraryStore.getState().retryMapPage('large', 1)).toThrow('ENOSPC');
  expect(recovery.clearInterruptedPdfRender).not.toHaveBeenCalled();
  const map = useLibraryStore.getState().maps.find((m) => m.id === 'large');
  expect(map?.activePages).toEqual([0]);
  expect(map?.renderRecoveryErrors).toEqual([{ pageIndex: 1, reason: 'interrupted' }]);
});

it('acknowledges a matching protected checkpoint only after saving explicit retry', async () => {
  await useLibraryStore.getState().hydrate();
  jest.mocked(storage.writeIndex).mockClear();
  jest.mocked(recovery.clearInterruptedPdfRender).mockClear();
  useLibraryStore.getState().retryMapPage('large', 1);
  expect(recovery.clearInterruptedPdfRender).toHaveBeenCalledWith('interrupted');
  expect(jest.mocked(storage.writeIndex).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(recovery.clearInterruptedPdfRender).mock.invocationCallOrder[0]!,
  );
});

it('does not acknowledge a different page checkpoint when retrying', async () => {
  await useLibraryStore.getState().hydrate();
  jest
    .mocked(recovery.readInterruptedPdfRender)
    .mockReturnValue({ token: 'other', fileUri: 'file:///doc/maps/large.pdf', pageIndex: 0 });
  jest.mocked(recovery.clearInterruptedPdfRender).mockClear();
  useLibraryStore.getState().retryMapPage('large', 1);
  expect(recovery.clearInterruptedPdfRender).not.toHaveBeenCalled();
});

it('does not publish retry activation if matching checkpoint acknowledgement fails', async () => {
  await useLibraryStore.getState().hydrate();
  jest.mocked(recovery.clearInterruptedPdfRender).mockImplementationOnce(() => {
    throw new Error('checkpoint write failed');
  });
  expect(() => useLibraryStore.getState().retryMapPage('large', 1)).toThrow(
    'checkpoint write failed',
  );
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'large')?.activePages).toEqual([0]);
  expect(
    useLibraryStore.getState().maps.find((m) => m.id === 'large')?.renderRecoveryErrors,
  ).toEqual([{ pageIndex: 1, reason: 'interrupted' }]);
});

it('records a known interrupted render even if its page was unticked before the process exited', async () => {
  const saved = index();
  saved.maps[0]!.activePages = [0];
  jest.mocked(storage.readIndex).mockResolvedValue(saved);
  await useLibraryStore.getState().hydrate();
  const map = useLibraryStore.getState().maps.find((m) => m.id === 'large');
  expect(map?.activePages).toEqual([0]);
  expect(map?.renderRecoveryErrors).toEqual([{ pageIndex: 1, reason: 'interrupted' }]);
});

it('durably pauses only the page whose current dispatched render failed', async () => {
  jest.mocked(recovery.readInterruptedPdfRender).mockReturnValue(null);
  await useLibraryStore.getState().hydrate();
  useLibraryStore
    .getState()
    .pauseMapPageAfterRenderFailure('large', 1, 'render timed out after 45000ms');
  const saved = jest.mocked(storage.writeIndex).mock.calls[0]![0];
  useLibraryStore.setState({ hydrated: false, maps: [] });
  jest.mocked(storage.readIndex).mockResolvedValue(saved);
  await useLibraryStore.getState().hydrate();
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'large')).toMatchObject({
    activePages: [0],
    renderRecoveryErrors: [
      { pageIndex: 1, reason: 'render-failed', message: 'render timed out after 45000ms' },
    ],
  });
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'working')?.activePages).toEqual([0]);
});
it('pauses in memory without masking a render error when persistence fails', async () => {
  jest.mocked(recovery.readInterruptedPdfRender).mockReturnValue(null);
  await useLibraryStore.getState().hydrate();
  jest.mocked(storage.writeIndex).mockImplementationOnce(() => {
    throw new Error('ENOSPC');
  });
  expect(() =>
    useLibraryStore.getState().pauseMapPageAfterRenderFailure('large', 1, 'x'.repeat(900)),
  ).not.toThrow();
  const map = useLibraryStore.getState().maps.find((m) => m.id === 'large');
  expect(map?.activePages).toEqual([0]);
  expect(map?.renderRecoveryErrors?.[0]).toMatchObject({
    reason: 'render-failed',
    message: 'x'.repeat(400),
  });
});

it('ignores late failures from a replaced file or revision', async () => {
  jest.mocked(recovery.readInterruptedPdfRender).mockReturnValue(null);
  await useLibraryStore.getState().hydrate();
  useLibraryStore.getState().pauseMapPageAfterRenderFailure('large', 1, 'old file', {
    fileUri: 'maps/obsolete.pdf',
    importedAt: 1,
  });
  useLibraryStore.getState().pauseMapPageAfterRenderFailure('large', 1, 'old revision', {
    fileUri: 'maps/large.pdf',
    importedAt: 0,
  });
  expect(useLibraryStore.getState().maps.find((m) => m.id === 'large')?.activePages).toEqual([
    0, 1,
  ]);
  expect(storage.writeIndex).not.toHaveBeenCalled();
});
