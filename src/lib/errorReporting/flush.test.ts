import { emptyQueueDoc } from '@core/errors/queue';
import type { ErrorQueueDoc, ErrorReport } from '@core/errors/types';

/**
 * Delivery-path tests for the (fully automatic, never user-facing) error
 * reporter: channel selection, dedupe → comment vs create, the client-side rate
 * limit, transient-failure backoff, and poison-pill dropping.
 */

const mockExtra: Record<string, unknown> = {};
const mockDoc: { value: ErrorQueueDoc } = { value: emptyQueueDoc() };

const mockGithub = {
  findOpenIssueByMarker: jest.fn<Promise<number | null>, [string, string, string]>(),
  createIssue: jest.fn<Promise<number>, [string, string, string, string]>(),
  addIssueComment: jest.fn<Promise<void>, [string, string, number, string]>(),
};
const mockEndpoint = { postReportToEndpoint: jest.fn<Promise<void>, [string, ErrorReport]>() };

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.5', extra: mockExtra } },
}));

jest.mock('@data/errorQueue', () => ({
  readErrorQueueDoc: () => Promise.resolve(mockDoc.value),
  writeErrorQueueDoc: (doc: ErrorQueueDoc) => {
    mockDoc.value = doc;
  },
}));

jest.mock('./github', () => ({
  ...jest.requireActual<object>('./github'),
  findOpenIssueByMarker: (...args: [string, string, string]) =>
    mockGithub.findOpenIssueByMarker(...args),
  createIssue: (...args: [string, string, string, string]) => mockGithub.createIssue(...args),
  addIssueComment: (...args: [string, string, number, string]) =>
    mockGithub.addIssueComment(...args),
}));

jest.mock('./endpoint', () => ({
  ...jest.requireActual<object>('./endpoint'),
  postReportToEndpoint: (...args: [string, ErrorReport]) =>
    mockEndpoint.postReportToEndpoint(...args),
}));

function report(fingerprint = 'aabbccdd'): ErrorReport {
  return {
    fingerprint,
    message: 'TypeError: boom',
    isFatal: false,
    breadcrumbs: [],
    firstSeenAt: 1000,
    lastSeenAt: 1000,
    count: 1,
    environment: { appVersion: '1.0.5', os: 'android 16' },
  };
}

/**
 * Fresh module instance (the queue + backoff state live at module scope, so
 * every case needs its own registry).
 */
function loadReporter(
  extra: Record<string, unknown>,
  queue: ErrorReport[],
  sentHistory: number[] = [],
): typeof import('./index') {
  for (const key of Object.keys(mockExtra)) delete mockExtra[key];
  Object.assign(mockExtra, extra);
  mockDoc.value = { ...emptyQueueDoc(), queue, sentHistory };
  jest.resetModules();
  return jest.requireActual<typeof import('./index')>('./index');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGithub.findOpenIssueByMarker.mockResolvedValue(null);
  mockGithub.createIssue.mockResolvedValue(1);
  mockGithub.addIssueComment.mockResolvedValue(undefined);
  mockEndpoint.postReportToEndpoint.mockResolvedValue(undefined);
});

describe('flushErrorQueue', () => {
  it('stays silent and keeps the queue when the build has no delivery channel', async () => {
    const { flushErrorQueue } = loadReporter({}, [report()]);
    const result = await flushErrorQueue();
    expect(result).toMatchObject({ status: 'no-channel', delivered: 0, queued: 1 });
    expect(mockGithub.createIssue).not.toHaveBeenCalled();
    expect(mockDoc.value.queue).toHaveLength(1); // waits on disk for a build that can file it
  });

  it('files a new issue and dequeues the report', async () => {
    const { flushErrorQueue, ERROR_REPORT_REPO } = loadReporter({ errorReportToken: 't' }, [
      report(),
    ]);
    const result = await flushErrorQueue();
    expect(result).toMatchObject({ status: 'delivered', delivered: 1, queued: 0 });
    expect(mockGithub.createIssue).toHaveBeenCalledWith(
      't',
      ERROR_REPORT_REPO,
      expect.stringContaining('[auto-report:aabbccdd]'),
      expect.stringContaining('### Message'),
    );
    expect(mockDoc.value.queue).toHaveLength(0);
    expect(mockDoc.value.sentHistory).toHaveLength(1);
  });

  it('comments on the existing issue instead of filing a duplicate', async () => {
    mockGithub.findOpenIssueByMarker.mockResolvedValue(42);
    const { flushErrorQueue } = loadReporter({ errorReportToken: 't' }, [report()]);
    await flushErrorQueue();
    expect(mockGithub.createIssue).not.toHaveBeenCalled();
    expect(mockGithub.addIssueComment).toHaveBeenCalledWith(
      't',
      expect.any(String),
      42,
      expect.stringContaining('Seen again'),
    );
  });

  it('prefers the relay endpoint over an embedded token', async () => {
    const { flushErrorQueue } = loadReporter(
      { errorReportToken: 't', errorReportEndpoint: 'https://relay.example/report' },
      [report()],
    );
    const result = await flushErrorQueue();
    expect(result.status).toBe('delivered');
    expect(mockEndpoint.postReportToEndpoint).toHaveBeenCalledWith(
      'https://relay.example/report',
      expect.objectContaining({ fingerprint: 'aabbccdd' }),
    );
    expect(mockGithub.createIssue).not.toHaveBeenCalled();
  });

  it('keeps the queue and backs off after a transient failure', async () => {
    mockGithub.createIssue.mockRejectedValue(new Error('Network request failed'));
    const { flushErrorQueue } = loadReporter({ errorReportToken: 't' }, [report()]);

    expect(await flushErrorQueue()).toMatchObject({ status: 'failed', queued: 1 });
    expect(mockDoc.value.queue).toHaveLength(1);

    // Immediately retrying is suppressed by the backoff (no second API call)…
    expect(mockGithub.createIssue).toHaveBeenCalledTimes(1);
    expect(await flushErrorQueue()).toMatchObject({ status: 'backoff', queued: 1 });
    expect(mockGithub.createIssue).toHaveBeenCalledTimes(1);

    // …but the Settings "Send now" row can force an attempt, and it succeeds.
    mockGithub.createIssue.mockResolvedValue(7);
    expect(await flushErrorQueue({ force: true })).toMatchObject({ status: 'delivered' });
    expect(mockDoc.value.queue).toHaveLength(0);
  });

  it('drops a report GitHub refuses (422) so it cannot block the queue', async () => {
    const { flushErrorQueue } = loadReporter({ errorReportToken: 't' }, [
      report('deadbeef'),
      report('cafebabe'),
    ]);
    // Same module registry as the reporter under test, so `instanceof` matches.
    const { GitHubApiError } = jest.requireActual<typeof import('./github')>('./github');
    mockGithub.createIssue
      .mockRejectedValueOnce(new GitHubApiError(422, 'Validation failed'))
      .mockResolvedValueOnce(9);
    const result = await flushErrorQueue();
    expect(result).toMatchObject({ status: 'delivered', delivered: 1, dropped: 1, queued: 0 });
    expect(mockDoc.value.queue).toHaveLength(0);
  });

  it('honours the client-side daily rate limit', async () => {
    const now = Date.now();
    const { flushErrorQueue } = loadReporter(
      { errorReportToken: 't' },
      [report()],
      [now - 1, now - 2, now - 3, now - 4, now - 5], // MAX_REPORTS_PER_DAY = 5
    );
    expect(await flushErrorQueue()).toMatchObject({ status: 'rate-limited', queued: 1 });
    expect(mockGithub.createIssue).not.toHaveBeenCalled();
  });

  it('does nothing when the user has opted out', async () => {
    const { flushErrorQueue } = loadReporter({ errorReportToken: 't' }, [report()]);
    const { useSettingsStore } =
      jest.requireActual<typeof import('@state/settingsStore')>('@state/settingsStore');
    useSettingsStore.setState({ errorReporting: false });
    try {
      expect(await flushErrorQueue()).toMatchObject({ status: 'disabled' });
      expect(mockGithub.createIssue).not.toHaveBeenCalled();
    } finally {
      useSettingsStore.setState({ errorReporting: true });
    }
  });
});

describe('getErrorQueueStatus', () => {
  it('reports the pending count and the channel for the Settings diagnostics row', async () => {
    const { getErrorQueueStatus } = loadReporter({ errorReportToken: 't' }, [report()], [1]);
    await expect(getErrorQueueStatus()).resolves.toMatchObject({ queued: 1, channel: 'github' });

    const noChannel = loadReporter({}, []);
    await expect(noChannel.getErrorQueueStatus()).resolves.toMatchObject({
      queued: 0,
      channel: 'none',
    });
  });
});
