/**
 * What to print under the Settings version row (#341).
 *
 * The version string comes from the binary and an over-the-air update never
 * changes it, so "1.5.2" alone cannot tell a phone running today's bundle
 * from one three days stale — which is exactly the confusion that made a
 * shipped fix look missing. These lines say which bundle is actually running.
 */

export interface UpdateFacts {
  /** `Updates.isEmbeddedLaunch`: running the bundle that shipped in the binary. */
  isEmbeddedLaunch: boolean;
  /** `Updates.updateId`: null in development and for some embedded launches. */
  updateId: string | null;
  /** `Updates.createdAt`: when the running update was published. */
  createdAt: Date | null;
  /** `Updates.isEmergencyLaunch`: the update failed and the binary's copy ran. */
  isEmergencyLaunch: boolean;
  /** False in Expo Go / a dev client, where none of the above means anything. */
  isEnabled: boolean;
}

/** Short, stable id for a human to read out loud or paste into a report. */
export function shortUpdateId(updateId: string | null): string | null {
  if (!updateId) return null;
  const compact = updateId.replace(/-/g, '');
  return compact.length >= 8 ? compact.slice(0, 8) : null;
}

/**
 * `12 Sep, 14:05` — day and time, no year, no seconds. Local time on purpose:
 * the question this answers is "did the thing I published an hour ago arrive?"
 */
export function formatUpdateTime(date: Date, now: Date = new Date()): string {
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

/**
 * The line under the version, or `null` when there is nothing worth saying
 * (a development build, where updates are off and the id is meaningless).
 */
export function describeRunningUpdate(facts: UpdateFacts, now: Date = new Date()): string | null {
  if (!facts.isEnabled) return null;

  if (facts.isEmergencyLaunch) {
    // The downloaded update failed to load and the binary's own bundle ran
    // instead. Saying "up to date" here would be a lie.
    return 'Update failed to load — running the version built into the app';
  }

  if (facts.isEmbeddedLaunch || facts.createdAt === null) {
    return 'Running the version built into the app';
  }

  const short = shortUpdateId(facts.updateId);
  const when = formatUpdateTime(facts.createdAt, now);
  return short === null ? `Updated ${when}` : `Updated ${when} · ${short}`;
}
