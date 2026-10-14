import { copyToSharedCache } from '@data/storage';
import * as Sharing from 'expo-sharing';

import { openMapPdf } from './openMapPdf';

jest.mock('@data/storage', () => ({
  copyToSharedCache: jest.fn(async (_from: string, name: string) => `file:///cache/shared/${name}`),
  resolveDocumentPath: (p: string) => `file:///docs/${p}`,
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

const copy = copyToSharedCache as jest.Mock;
const share = Sharing.shareAsync as jest.Mock;
const MAP = { fileUri: 'maps/4f9c2e.pdf', name: 'Rivière du Nord (Dumoine) 2022' };

beforeEach(() => {
  copy.mockClear();
  share.mockClear();
});

it('hands the PDF over under the map’s title, not its stored id (2.5.2 QA)', async () => {
  expect(await openMapPdf(MAP)).toBe(true);
  expect(copy).toHaveBeenCalledWith('maps/4f9c2e.pdf', 'Rivière du Nord (Dumoine) 2022.pdf');
  expect(share).toHaveBeenCalledWith(
    'file:///cache/shared/Rivière du Nord (Dumoine) 2022.pdf',
    expect.objectContaining({ mimeType: 'application/pdf', dialogTitle: MAP.name }),
  );
});

it('still opens the stored file when the copy fails (a full disk)', async () => {
  copy.mockRejectedValueOnce(new Error('ENOSPC'));
  expect(await openMapPdf(MAP)).toBe(true);
  expect(share).toHaveBeenCalledWith('file:///docs/maps/4f9c2e.pdf', expect.anything());
});

it('says so when the device cannot hand files over', async () => {
  (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
  expect(await openMapPdf(MAP)).toBe(false);
  expect(copy).not.toHaveBeenCalled();
});
