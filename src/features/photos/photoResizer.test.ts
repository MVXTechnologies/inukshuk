import type { PhotoResizer, ResizedPhoto } from '@data/photos/resizer';

import { HOST_WAIT_MS, photoResizer, registerPhotoResizer } from './photoResizer';

const result = { totalMs: 1 } as ResizedPhoto;
const fake = (): PhotoResizer & { resize: jest.Mock } => ({
  resize: jest.fn(async () => result),
});

afterEach(() => {
  registerPhotoResizer(null);
  jest.useRealTimers();
});

it('passes jobs to the registered host', async () => {
  const host = fake();
  registerPhotoResizer(host);
  await expect(photoResizer.resize('file:///a.jpg')).resolves.toBe(result);
  expect(host.resize).toHaveBeenCalledWith('file:///a.jpg');
});

it('holds a job until the host comes up', async () => {
  const pending = photoResizer.resize('file:///a.jpg');
  const host = fake();
  registerPhotoResizer(host);
  await expect(pending).resolves.toBe(result);
});

it('gives up when no host comes up', async () => {
  jest.useFakeTimers();
  const pending = photoResizer.resize('file:///a.jpg');
  jest.advanceTimersByTime(HOST_WAIT_MS + 1);
  await expect(pending).rejects.toThrow('not available');
  // A host registered later serves new jobs only.
  const host = fake();
  registerPhotoResizer(host);
  expect(host.resize).not.toHaveBeenCalled();
});
