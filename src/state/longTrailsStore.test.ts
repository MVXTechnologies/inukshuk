import { sampleDetail, sampleIndex } from '@core/trails/__fixtures__/trails';
import { loadTrailDetail, loadTrailIndex } from '@data/longTrails';

import { resetLongTrailsStore, useLongTrailsStore } from './longTrailsStore';

jest.mock('@data/longTrails', () => ({ loadTrailIndex: jest.fn(), loadTrailDetail: jest.fn() }));

const indexMock = loadTrailIndex as jest.Mock;
const detailMock = loadTrailDetail as jest.Mock;

beforeEach(() => {
  resetLongTrailsStore();
  indexMock.mockResolvedValue({ index: sampleIndex(), fromCache: false });
  detailMock.mockResolvedValue(sampleDetail(true));
});

it('loads the index once, even when asked twice at the same time', async () => {
  const s = useLongTrailsStore.getState();
  await Promise.all([s.load(), s.load()]);
  expect(indexMock).toHaveBeenCalledTimes(1);
  expect(useLongTrailsStore.getState().status).toBe('ready');
  await useLongTrailsStore.getState().load();
  expect(indexMock).toHaveBeenCalledTimes(1);
  await useLongTrailsStore.getState().load(true);
  expect(indexMock).toHaveBeenCalledTimes(2);
});

it('is unavailable when there is no index anywhere, and keeps a loaded one on a failed refresh', async () => {
  indexMock.mockResolvedValue(null);
  await useLongTrailsStore.getState().load();
  expect(useLongTrailsStore.getState().status).toBe('unavailable');

  indexMock.mockResolvedValue({ index: sampleIndex(), fromCache: true });
  await useLongTrailsStore.getState().load(true);
  expect(useLongTrailsStore.getState()).toMatchObject({ status: 'ready', fromCache: true });
  indexMock.mockRejectedValue(new Error('boom'));
  await useLongTrailsStore.getState().load(true);
  expect(useLongTrailsStore.getState().status).toBe('ready');
});

it('loads details for the index version and remembers failures', async () => {
  expect(await useLongTrailsStore.getState().loadDetail('r8730405')).toBeNull(); // no index yet
  await useLongTrailsStore.getState().load();
  const d = await useLongTrailsStore.getState().loadDetail('r8730405');
  expect(detailMock).toHaveBeenCalledWith('r8730405', 'pilot1');
  expect(d?.id).toBe('r8730405');
  expect(await useLongTrailsStore.getState().loadDetail('r8730405')).toBe(d);
  expect(detailMock).toHaveBeenCalledTimes(1);

  detailMock.mockResolvedValue(null);
  await useLongTrailsStore.getState().loadDetail('r9');
  expect(useLongTrailsStore.getState().detailStatus.r9).toBe('failed');
});

it('shows, steps and hides the trail on the map', () => {
  const detail = sampleDetail(true);
  const s = useLongTrailsStore.getState();
  s.setStage(1); // nothing shown: no-op
  expect(useLongTrailsStore.getState().shown).toBeNull();
  s.show(detail, 0);
  s.setStage(2);
  expect(useLongTrailsStore.getState().shown).toEqual({ detail, stageIndex: 2 });
  s.hide();
  expect(useLongTrailsStore.getState().shown).toBeNull();
});
