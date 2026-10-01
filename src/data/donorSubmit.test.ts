import { DONORS_URL, submitDonorName } from './donorSubmit';

const body = { name: 'Anne', place: null, platform: 'android' as const, transactionIds: ['GPA.1'] };

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

it('posts the submission as JSON to the Worker', async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 202 });
  await expect(submitDonorName(body)).resolves.toBe('sent');
  expect(DONORS_URL).toMatch(/^https:\/\/.+\/donors$/);
  expect(fetchMock).toHaveBeenCalledWith(
    DONORS_URL,
    expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }),
  );
});

it.each([
  [429, 'rate-limited'],
  [400, 'rejected'],
  [502, 'offline'],
])('maps HTTP %p to %s', async (status, expected) => {
  fetchMock.mockResolvedValue({ ok: false, status });
  await expect(submitDonorName(body)).resolves.toBe(expected);
});

it('reports a network failure as offline', async () => {
  fetchMock.mockRejectedValue(new Error('offline'));
  await expect(submitDonorName(body)).resolves.toBe('offline');
});
