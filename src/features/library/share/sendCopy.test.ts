import type { SharePlan } from '@core/library/sharePlan';
import * as Sharing from 'expo-sharing';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { Share } from 'react-native';

import { planBytes, sendCopy } from './sendCopy';

const mockFiles: Record<string, Uint8Array> = {
  'file:///t1.gpx': strToU8('<gpx>one</gpx>'),
  'file:///m1.pdf': strToU8('%PDF-1.7 fake'),
};
const mockWritten: Record<string, Uint8Array[]> = {};
const mockDeleted: string[] = [];
const mockCopy = jest.fn(async (_src: string, name: string) => `file:///cache/shared/${name}`);

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('@data/storage', () => ({
  fileSizeAt: (uri: string) => mockFiles[uri]?.length ?? 0,
  fileExists: (uri: string) => uri in mockFiles,
  readFileChunks: (uri: string, size: number, onChunk: (c: Uint8Array, f: boolean) => void) => {
    const bytes = mockFiles[uri]!;
    for (let i = 0; i < bytes.length; i += size) {
      onChunk(bytes.subarray(i, i + size), i + size >= bytes.length);
    }
  },
  createCacheFileWriter: (name: string) => {
    const uri = `file:///cache/exports/${name}`;
    mockWritten[uri] = [];
    return { uri, write: (c: Uint8Array) => mockWritten[uri]!.push(c.slice()), close: () => {} };
  },
  copyToSharedCache: (src: string, name: string) => mockCopy(src, name),
  deleteFileAt: (uri: string) => mockDeleted.push(uri),
}));

const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

beforeEach(() => {
  jest.mocked(Sharing.shareAsync).mockClear();
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
  mockDeleted.length = 0;
  mockCopy.mockClear();
});

const zip: SharePlan = {
  kind: 'zip',
  fileName: 'Gaspésie 2026.zip',
  files: [
    { path: 'Mont-Albert.pdf', sourceUri: 'file:///m1.pdf', kind: 'pdf' },
    { path: 'Loop.gpx', sourceUri: 'file:///t1.gpx', kind: 'gpx' },
    { path: 'Gone.gpx', sourceUri: 'file:///gone.gpx', kind: 'gpx' },
  ],
  texts: [{ path: 'Catalog maps.txt', text: 'Rivière du Berger', kind: 'links' }],
  links: [],
  trails: 2,
  pdfs: 1,
  waypoints: 0,
  areas: 0,
};

describe('sendCopy', () => {
  it('streams a zip of the files and texts, shares it, then deletes the staged file', async () => {
    expect(await sendCopy(zip, 'Share “Gaspésie 2026”')).toEqual({ kind: 'shared' });
    const uri = 'file:///cache/exports/Gaspésie 2026.zip';
    const entries = unzipSync(concat(mockWritten[uri]!));
    expect(Object.keys(entries)).toEqual(['Mont-Albert.pdf', 'Loop.gpx', 'Catalog maps.txt']);
    expect(strFromU8(entries['Loop.gpx']!)).toBe('<gpx>one</gpx>');
    expect(strFromU8(entries['Catalog maps.txt']!)).toBe('Rivière du Berger');
    expect(Sharing.shareAsync).toHaveBeenCalledWith(uri, {
      mimeType: 'application/zip',
      UTI: 'public.zip-archive',
      dialogTitle: 'Share “Gaspésie 2026”',
    });
    expect(mockDeleted).toEqual([uri]);
  });

  it('copies one trail under its name and shares it as GPX', async () => {
    const plan: SharePlan = { kind: 'gpx', fileName: 'Loop.gpx', sourceUri: 'file:///t1.gpx' };
    expect(await sendCopy(plan, 'Share trail')).toEqual({ kind: 'shared' });
    expect(mockCopy).toHaveBeenCalledWith('file:///t1.gpx', 'Loop.gpx');
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/shared/Loop.gpx', {
      mimeType: 'application/gpx+xml',
      UTI: 'public.xml',
      dialogTitle: 'Share trail',
    });
    expect(planBytes(plan)).toBe(14);
  });

  it('shares a map as its PDF', async () => {
    const plan: SharePlan = { kind: 'pdf', fileName: 'Map.pdf', sourceUri: 'file:///m1.pdf' };
    await sendCopy(plan, 'Share map');
    expect(jest.mocked(Sharing.shareAsync).mock.calls[0]?.[1]).toMatchObject({
      mimeType: 'application/pdf',
    });
  });

  it('writes a waypoints GPX to the cache and drops it after', async () => {
    const plan: SharePlan = {
      kind: 'waypoints',
      fileName: 'Waypoints.gpx',
      text: '<gpx/>',
      waypoints: 1,
      areas: 0,
    };
    await sendCopy(plan, 'Share waypoint');
    expect(strFromU8(concat(mockWritten['file:///cache/exports/Waypoints.gpx']!))).toBe('<gpx/>');
    expect(mockDeleted).toEqual(['file:///cache/exports/Waypoints.gpx']);
    expect(planBytes(plan)).toBe(6);
  });

  it('sends catalog links as text, never a file', async () => {
    const spy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const plan: SharePlan = { kind: 'link', message: 'Rivière\nhttps://x', links: [] };
    expect(await sendCopy(plan, 'Share map')).toEqual({ kind: 'shared' });
    expect(spy).toHaveBeenCalledWith({ message: 'Rivière\nhttps://x', title: 'Share map' });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(planBytes(plan)).toBe(0);
  });

  it('says when the device cannot share, and reports a failure', async () => {
    jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);
    expect(await sendCopy(zip, 'x')).toEqual({ kind: 'unavailable' });
    jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
    mockCopy.mockRejectedValueOnce(new Error('disk full'));
    expect(
      await sendCopy({ kind: 'gpx', fileName: 'a.gpx', sourceUri: 'file:///t1.gpx' }, 'x'),
    ).toEqual({ kind: 'error', message: 'disk full' });
    expect(planBytes(zip)).toBe(13 + 14 + 0 + strToU8('Rivière du Berger').length);
  });
});
