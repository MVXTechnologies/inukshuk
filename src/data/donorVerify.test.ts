import {
  checkDonorVerify,
  startDonorVerify,
  VERIFY_CHECK_URL,
  VERIFY_START_URL,
} from './donorVerify';

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const res = (status: number) => ({ ok: status >= 200 && status < 300, status });

it('asks the Worker to email a code', async () => {
  fetchMock.mockResolvedValue(res(202));
  await expect(startDonorVerify('a@b.ca')).resolves.toBe('sent');
  expect(fetchMock).toHaveBeenCalledWith(
    VERIFY_START_URL,
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'a@b.ca' }) }),
  );
  expect(VERIFY_START_URL).toMatch(/\/donor-verify\/start$/);
});

it.each([
  [429, 'rate-limited'],
  [400, 'invalid'],
  [404, 'offline'],
  [503, 'offline'],
])('maps a start answer %p to %s', async (status, expected) => {
  fetchMock.mockResolvedValue(res(status));
  await expect(startDonorVerify('a@b.ca')).resolves.toBe(expected);
});

it.each([
  [200, 'ok'],
  [400, 'rejected'],
  [429, 'rate-limited'],
  [502, 'offline'],
])('maps a check answer %p to %s', async (status, expected) => {
  fetchMock.mockResolvedValue(res(status));
  await expect(checkDonorVerify('a@b.ca', '123456')).resolves.toBe(expected);
  expect(fetchMock).toHaveBeenCalledWith(VERIFY_CHECK_URL, expect.anything());
});

it('reports a network failure as offline', async () => {
  fetchMock.mockRejectedValue(new Error('offline'));
  await expect(startDonorVerify('a@b.ca')).resolves.toBe('offline');
  await expect(checkDonorVerify('a@b.ca', '123456')).resolves.toBe('offline');
});
