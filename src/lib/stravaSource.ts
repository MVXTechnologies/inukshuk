import {
  nextUtcMidnight,
  rateLimitDelayMs,
  remoteToStravaSummary,
  stravaSummaryToRemote,
  type RateLimitState,
} from '@core/strava/activities';
import {
  SourceStopError,
  type ActivityRoute,
  type ActivitySource,
  type ImportPause,
  type RemoteActivity,
} from '@core/import/sources';

import { StravaReadError, fetchStravaActivityPoints, listStravaActivities } from './strava';

/**
 * Strava as a connected activity source (#432): pages the athlete's activity
 * list, fetches each activity's streams, and keeps inside Strava's read
 * limits (~100 per 15 minutes, ~1,000 a day). A nearly spent 15-minute window
 * is sat out in place (reported through `onPause`, abortable); a spent daily
 * budget stops the import with a `daily-limit` {@link SourceStopError} so the
 * job can pause until midnight UTC and resume. A refused token stops it with
 * `auth` ("reconnect").
 */

export interface StravaApi {
  list: typeof listStravaActivities;
  points: typeof fetchStravaActivityPoints;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/** Wait `ms`, or reject with an AbortError as soon as `signal` aborts. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

const DEFAULT_API: StravaApi = {
  list: listStravaActivities,
  points: fetchStravaActivityPoints,
  now: () => Date.now(),
  sleep: sleepUnlessAborted,
};

/** Retries of a 429 (after waiting out the window) before calling it a day. */
const MAX_RATE_LIMIT_RETRIES = 2;
/** Never page further than this (100 per page: 100,000 activities). */
const MAX_PAGES = 1000;

const DAILY_LIMIT_MESSAGE = 'Strava’s daily limit reached';

export function createStravaSource(api: StravaApi = DEFAULT_API): ActivitySource {
  /** Once the daily budget is spent: when it comes back. */
  let exhaustedUntil: number | null = null;

  const checkBudget = () => {
    if (exhaustedUntil === null) return;
    if (api.now() < exhaustedUntil) {
      throw new SourceStopError(DAILY_LIMIT_MESSAGE, 'daily-limit', exhaustedUntil);
    }
    exhaustedUntil = null;
  };

  const waitOut = async (
    ms: number,
    signal: AbortSignal,
    onPause?: (pause: ImportPause) => void,
  ) => {
    onPause?.({ kind: 'rate-limit', resumeAt: api.now() + ms });
    try {
      await api.sleep(ms, signal);
    } finally {
      onPause?.(null);
    }
  };

  /** After a response: sit out a spent 15-minute window, remember a spent day. */
  const throttle = async (
    rate: RateLimitState | null,
    signal: AbortSignal,
    onPause?: (pause: ImportPause) => void,
  ) => {
    const delay = rateLimitDelayMs(rate, api.now());
    if (delay === null) exhaustedUntil = nextUtcMidnight(api.now());
    else if (delay > 0) await waitOut(delay, signal, onPause);
  };

  /** One read, with Strava's errors turned into the importer's. */
  async function call<T>(
    read: () => Promise<T>,
    signal: AbortSignal,
    onPause?: (pause: ImportPause) => void,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      checkBudget();
      if (signal.aborted) throw abortError();
      try {
        return await read();
      } catch (err) {
        if (!(err instanceof StravaReadError)) throw err;
        if (err.kind === 'auth') throw new SourceStopError(err.message, 'auth');
        if (err.kind !== 'rate-limited') throw err;
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          exhaustedUntil = nextUtcMidnight(api.now());
          throw new SourceStopError(DAILY_LIMIT_MESSAGE, 'daily-limit', exhaustedUntil);
        }
        // A 429 with no usable headers: wait for the next 15-minute window.
        const full: RateLimitState = { shortUsed: 1, shortLimit: 1, dailyUsed: 0, dailyLimit: 10 };
        await waitOut(rateLimitDelayMs(full, api.now()) ?? 0, signal, onPause);
      }
    }
  }

  return {
    id: 'strava',

    async list(since, signal, onPause) {
      const after = since > 0 ? Math.max(0, Math.floor(since / 1000) - 1) : undefined;
      const out: RemoteActivity[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { activities, rate } = await call(() => api.list(page, after), signal, onPause);
        if (activities.length === 0) break;
        let anyInRange = false;
        for (const a of activities) {
          if (a.startTime < since) continue;
          anyInRange = true;
          out.push(stravaSummaryToRemote(a));
        }
        // A page entirely before `since` (should `after` be ignored): done.
        if (!anyInRange) break;
        await throttle(rate, signal, onPause);
      }
      out.sort((a, b) => b.startedAt - a.startedAt);
      return out;
    },

    async fetchRoute(activity, signal, onPause): Promise<ActivityRoute> {
      const summary = remoteToStravaSummary(activity);
      if (!summary) return { points: [], segmentStarts: [] };
      const { points, rate } = await call(() => api.points(summary), signal, onPause);
      await throttle(rate, signal, onPause);
      return { points, segmentStarts: [] };
    },
  };
}
