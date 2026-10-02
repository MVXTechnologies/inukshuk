import * as storage from '@data/storage';

import { useSupportStore } from './supportStore';

let mockSaved: unknown = null;
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => mockSaved),
}));

const writeJson = storage.writeJson as jest.Mock;

beforeEach(() => {
  mockSaved = null;
  useSupportStore.setState({
    totalCents: 0,
    tipCount: 0,
    transactionIds: [],
    donorSubmitted: false,
    hydrated: false,
  });
});

it('replays tips recorded before hydration over the saved ledger, once each', async () => {
  mockSaved = { totalCents: 9999, tipCount: 1, transactionIds: ['p1'], donorSubmitted: false };
  useSupportStore.getState().recordTip({ productId: 'tip_medium', transactionId: 't1' });
  // The launch sweep met the saved Patron tip again: not counted twice.
  useSupportStore.getState().recordTip({ productId: 'tip_patron', transactionId: 'p1' });
  await useSupportStore.getState().hydrate();
  const s = useSupportStore.getState();
  expect(s).toMatchObject({ totalCents: 9999 + 699, tipCount: 2, transactionIds: ['p1', 't1'] });
  expect(writeJson).toHaveBeenLastCalledWith('support.json', {
    totalCents: 10698,
    tipCount: 2,
    transactionIds: ['p1', 't1'],
    donorSubmitted: false,
  });
});

it('persists each tip after hydration and ignores replays', async () => {
  await useSupportStore.getState().hydrate();
  writeJson.mockClear();
  useSupportStore.getState().recordTip({ productId: 'tip_large', transactionId: 'a' });
  useSupportStore.getState().recordTip({ productId: 'tip_large', transactionId: 'a' });
  expect(writeJson).toHaveBeenCalledTimes(1);
  expect(useSupportStore.getState().totalCents).toBe(1499);
});

it('remembers that a donor name was sent, even before hydration', async () => {
  useSupportStore.getState().markDonorSubmitted();
  await useSupportStore.getState().hydrate();
  expect(useSupportStore.getState().donorSubmitted).toBe(true);
  useSupportStore.getState().markDonorSubmitted();
  expect(writeJson).toHaveBeenLastCalledWith(
    'support.json',
    expect.objectContaining({ donorSubmitted: true }),
  );
});

it('starts empty on an unreadable file', async () => {
  (storage.readJson as jest.Mock).mockRejectedValueOnce(new Error('io'));
  await useSupportStore.getState().hydrate();
  expect(useSupportStore.getState()).toMatchObject({ totalCents: 0, hydrated: true });
});
