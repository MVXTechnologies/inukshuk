import { WEATHER_USER_AGENT } from './useWeatherTimeline';

const REQUEST_TIMEOUT_MS = 12_000;

/** Bound headers and body reads; cancellation also settles transports that ignore abort. */
export async function fetchWeatherJson(url: string, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new Error('Weather request cancelled');
  const controller = new AbortController();
  let cancel = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      controller.abort();
      reject(new Error('Weather request cancelled or timed out'));
    };
  });
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, REQUEST_TIMEOUT_MS);
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, {
          headers: { 'User-Agent': WEATHER_USER_AGENT },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Weather response ${response.status}`);
        return await response.json();
      })(),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
