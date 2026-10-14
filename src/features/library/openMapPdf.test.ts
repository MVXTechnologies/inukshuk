import { copyToSharedCache } from '@data/storage';
import { reportError } from '@lib/errorReporting';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { openMapPdf, openMapPdfMessage } from './openMapPdf';

jest.mock('@data/storage', () => ({
  copyToSharedCache: jest.fn(async (_from: string, name: string) => `file:///cache/shared/${name}`),
  resolveDocumentPath: (p: string) => (p.startsWith('file://') ? p : `file:///docs/${p}`),
  contentUriFor: (uri: string) => uri.replace('file:///', 'content://app.provider/'),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-intent-launcher', () => ({
  startActivityAsync: jest.fn(async () => ({ resultCode: 0 })),
}));

const copy = copyToSharedCache as jest.Mock;
const share = Sharing.shareAsync as jest.Mock;
const view = IntentLauncher.startActivityAsync as jest.Mock;
const report = reportError as jest.Mock;
const MAP = { fileUri: 'maps/4f9c2e.pdf', name: 'Rivière du Nord (Dumoine) 2022' };
const SHARED = 'file:///cache/shared/Rivière du Nord (Dumoine) 2022.pdf';

beforeEach(() => {
  copy.mockClear();
  share.mockClear();
  view.mockClear();
  report.mockClear();
});

describe('on Android', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'android'));

  it('opens the PDF in a viewer with a VIEW intent and a read grant, not the share sheet', async () => {
    expect(await openMapPdf(MAP)).toBe('viewer');
    expect(view).toHaveBeenCalledTimes(1);
    expect(view).toHaveBeenCalledWith('android.intent.action.VIEW', {
      data: 'content://app.provider/cache/shared/Rivière du Nord (Dumoine) 2022.pdf',
      type: 'application/pdf',
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    });
    expect(share).not.toHaveBeenCalled();
  });

  it('keeps the map’s title as the file name the viewer shows', async () => {
    await openMapPdf(MAP);
    expect(copy).toHaveBeenCalledWith('maps/4f9c2e.pdf', 'Rivière du Nord (Dumoine) 2022.pdf');
  });

  it('falls back to the share sheet when no PDF viewer is installed, without a report', async () => {
    view.mockRejectedValueOnce(
      new Error('android.content.ActivityNotFoundException: No Activity found to handle Intent'),
    );
    expect(await openMapPdf(MAP)).toBe('no-viewer');
    expect(share).toHaveBeenCalledWith(
      SHARED,
      expect.objectContaining({ mimeType: 'application/pdf', dialogTitle: MAP.name }),
    );
    expect(report).not.toHaveBeenCalled();
  });

  it('reports an unexpected intent failure, and still falls back to the share sheet', async () => {
    view.mockRejectedValueOnce(new Error('SecurityException'));
    expect(await openMapPdf(MAP)).toBe('no-viewer');
    expect(share).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'open-map-pdf-view');
  });

  it('does not stack a share sheet on a second tap while the viewer is opening', async () => {
    view.mockRejectedValueOnce(
      Object.assign(new Error('already started'), { code: 'E_ACTIVITY_ALREADY_STARTED' }),
    );
    expect(await openMapPdf(MAP)).toBe('viewer');
    expect(share).not.toHaveBeenCalled();
  });

  it('views the stored file when the named copy fails (a full disk)', async () => {
    copy.mockRejectedValueOnce(new Error('ENOSPC'));
    expect(await openMapPdf(MAP)).toBe('viewer');
    expect(view).toHaveBeenCalledWith(
      'android.intent.action.VIEW',
      expect.objectContaining({ data: 'content://app.provider/docs/maps/4f9c2e.pdf' }),
    );
  });

  it('is unavailable with neither a viewer nor a share sheet', async () => {
    view.mockRejectedValueOnce(new Error('ActivityNotFoundException'));
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
    expect(await openMapPdf(MAP)).toBe('unavailable');
  });
});

describe('on iOS', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'ios'));

  it('shows the share sheet (Quick Look) under the map’s title, never an intent', async () => {
    expect(await openMapPdf(MAP)).toBe('shared');
    expect(view).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith('maps/4f9c2e.pdf', 'Rivière du Nord (Dumoine) 2022.pdf');
    expect(share).toHaveBeenCalledWith(
      SHARED,
      expect.objectContaining({ mimeType: 'application/pdf', UTI: 'com.adobe.pdf' }),
    );
  });

  it('still opens the stored file when the copy fails (a full disk)', async () => {
    copy.mockRejectedValueOnce(new Error('ENOSPC'));
    expect(await openMapPdf(MAP)).toBe('shared');
    expect(share).toHaveBeenCalledWith('file:///docs/maps/4f9c2e.pdf', expect.anything());
  });

  it('says so when the device cannot hand files over', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
    expect(await openMapPdf(MAP)).toBe('unavailable');
  });
});

describe('openMapPdfMessage', () => {
  it('speaks up only for the fallback and the dead end', () => {
    expect(openMapPdfMessage('viewer')).toBeNull();
    expect(openMapPdfMessage('shared')).toBeNull();
    expect(openMapPdfMessage('no-viewer')).toMatch(/No PDF viewer/);
    expect(openMapPdfMessage('unavailable')).toMatch(/not available/);
  });
});
