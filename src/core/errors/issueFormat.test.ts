import {
  buildIssueBody,
  buildIssueTitle,
  buildReportPayload,
  buildSeenAgainComment,
  ISSUE_BODY_MAX,
} from './issueFormat';
import type { ErrorReport } from './types';

const base: ErrorReport = {
  fingerprint: 'aabbccdd',
  message: 'TypeError: cannot read x of undefined',
  stack: 'TypeError: cannot read x of undefined\n    at parseGpx (bundle:1:2)',
  isFatal: true,
  context: 'gpx-import',
  breadcrumbs: ['opened library', 'imported track.gpx'],
  firstSeenAt: Date.UTC(2026, 6, 10, 12, 0, 0),
  lastSeenAt: Date.UTC(2026, 6, 11, 8, 30, 0),
  count: 3,
  environment: {
    appVersion: '1.0.5',
    runtimeVersion: '1.0.1',
    updateId: 'abcd-1234',
    os: 'android 16',
    model: 'SM-S938B',
  },
};

describe('buildIssueTitle', () => {
  it('starts with the dedupe marker and keeps the first message line', () => {
    expect(buildIssueTitle(base)).toBe(
      '[auto-report:aabbccdd] TypeError: cannot read x of undefined',
    );
    expect(buildIssueTitle({ ...base, message: 'line one\nline two' })).toBe(
      '[auto-report:aabbccdd] line one',
    );
  });

  it('truncates very long messages', () => {
    const title = buildIssueTitle({ ...base, message: 'x'.repeat(300) });
    expect(title.length).toBeLessThanOrEqual('[auto-report:aabbccdd] '.length + 80);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('buildIssueBody', () => {
  it('includes marker, metadata, message, stacks and breadcrumbs', () => {
    const body = buildIssueBody(base);
    expect(body).toContain('[auto-report:aabbccdd]');
    expect(body).toContain('| Fatal | yes |');
    expect(body).toContain('| Context | gpx-import |');
    expect(body).toContain('| Occurrences | 3 |');
    expect(body).toContain('| App version | 1.0.5 |');
    expect(body).toContain('| Runtime version | 1.0.1 |');
    expect(body).toContain('| Update id | abcd-1234 |');
    expect(body).toContain('| OS | android 16 |');
    expect(body).toContain('| Device | SM-S938B |');
    expect(body).toContain('| First seen | 2026-07-10T12:00:00.000Z |');
    expect(body).toContain('TypeError: cannot read x of undefined');
    expect(body).toContain('at parseGpx');
    expect(body).toContain('- opened library');
    expect(body).toContain('- imported track.gpx');
  });

  it('omits optional sections when absent', () => {
    const body = buildIssueBody({
      ...base,
      stack: undefined,
      componentStack: undefined,
      context: undefined,
      breadcrumbs: [],
      environment: { appVersion: '1.0.5', os: 'android 16' },
    });
    expect(body).not.toContain('### Stack');
    expect(body).not.toContain('### Component stack');
    expect(body).not.toContain('### Breadcrumbs');
    expect(body).not.toContain('| Context |');
    expect(body).not.toContain('| Runtime version |');
    expect(body).not.toContain('| Update id |');
    expect(body).not.toContain('| Device |');
  });

  it('includes the component stack when present', () => {
    const body = buildIssueBody({ ...base, componentStack: '\n  in MapScreen\n  in App' });
    expect(body).toContain('### Component stack');
    expect(body).toContain('in MapScreen');
  });

  it('caps a runaway stack under the GitHub body limit (a 422 would block the queue)', () => {
    const body = buildIssueBody({ ...base, stack: 'x'.repeat(200_000) });
    expect(body.length).toBeLessThanOrEqual(ISSUE_BODY_MAX);
    expect(body.endsWith('…')).toBe(true);
  });
});

describe('buildSeenAgainComment', () => {
  it('summarizes count, version, platform and time', () => {
    expect(buildSeenAgainComment(base)).toBe(
      'Seen again (x3, v1.0.5, android 16, SM-S938B) at 2026-07-11T08:30:00.000Z.',
    );
  });

  it('omits the device when unknown', () => {
    const noModel = { ...base, environment: { appVersion: '1.0.5', os: 'ios 19' } };
    expect(buildSeenAgainComment(noModel)).toBe(
      'Seen again (x3, v1.0.5, ios 19) at 2026-07-11T08:30:00.000Z.',
    );
  });
});

describe('buildReportPayload', () => {
  it('carries the marker plus the pre-rendered issue strings and the raw report', () => {
    const payload = buildReportPayload(base);
    expect(payload).toMatchObject({
      fingerprint: 'aabbccdd',
      marker: '[auto-report:aabbccdd]',
      title: buildIssueTitle(base),
      body: buildIssueBody(base),
      comment: buildSeenAgainComment(base),
      report: base,
    });
  });

  it('is JSON-serializable (it is POSTed as-is to the relay endpoint)', () => {
    expect(() => JSON.stringify(buildReportPayload(base))).not.toThrow();
  });
});
