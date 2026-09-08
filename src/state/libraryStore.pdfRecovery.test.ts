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
