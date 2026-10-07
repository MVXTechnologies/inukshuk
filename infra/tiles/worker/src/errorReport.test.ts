/**
 * POST /error-report (./errorReport.ts): the relay that files the app's crash
 * reports with a token kept on the Worker. Pure handler with fakes, run by
 * the app's Jest.
 */
import { buildReportPayload } from '../../../../src/core/errors/issueFormat';
import type { ErrorReport } from '../../../../src/core/errors/types';
import {
  githubIssues,
  GitHubError,
  handleErrorReport,
  MAX_ISSUE_BODY,
  parsePayload,
  upstreamStatus,
  type ErrorReportDeps,
  type GitHubIssueSummary,
} from './errorReport';

const payload = {
  fingerprint: '0a1b2c3d',
  marker: '[auto-report:0a1b2c3d]',
  title: '[auto-report:0a1b2c3d] TypeError: x is undefined',
  body: '[auto-report:0a1b2c3d]\n\n```\nTypeError: x is undefined\n```',
  comment: 'Seen again (x2, v2.0.1, android 16) at 2026-10-06T00:00:00.000Z.',
  report: { anything: 'ignored' },
};

function world(open: GitHubIssueSummary[] = [], allow = { client: true, issue: true }) {
  const created: { title: string; body: string }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const deps: ErrorReportDeps = {
    allowClient: async () => allow.client,
    allowNewIssue: async () => allow.issue,
    listOpenIssues: async () => open,
    createIssue: async (title, body) => {
      created.push({ title, body });
    },
    comment: async (issue, body) => {
      comments.push({ issue, body });
    },
  };
  const call = (body: unknown, method = 'POST') =>
    handleErrorReport(
      {
        method,
        client: '203.0.113.5',
        body: body === null ? null : typeof body === 'string' ? body : JSON.stringify(body),
      },
      deps,
    );
  return { created, comments, call };
}

describe('handleErrorReport', () => {
  it('files a new issue with the title and body as sent', async () => {
    const w = world();
    const res = await w.call(payload);
    expect(res).toEqual({ status: 202, body: { ok: true } });
    expect(w.created).toEqual([{ title: payload.title, body: payload.body }]);
    expect(w.comments).toEqual([]);
  });

  it('comments "seen again" on the open issue carrying the marker instead of a duplicate', async () => {
    const w = world([
      { number: 7, title: 'Unrelated' },
      { number: 9, title: `${payload.marker} TypeError` },
    ]);
    const res = await w.call(payload);
    expect(res.status).toBe(202);
    expect(w.comments).toEqual([{ issue: 9, body: payload.comment }]);
    expect(w.created).toEqual([]);
  });

  it('rate-limits per client before parsing, and caps new issues globally', async () => {
    const limited = world([], { client: false, issue: true });
    expect((await limited.call(payload)).status).toBe(429);
    const budget = world([], { client: true, issue: false });
    expect((await budget.call(payload)).status).toBe(429);
    expect(budget.created).toEqual([]);
    // A comment on an existing issue does not spend the new-issue budget.
    const seen = world([{ number: 3, title: payload.marker }], { client: true, issue: false });
    expect((await seen.call(payload)).status).toBe(202);
  });

  it('answers 405 to anything but POST and 400 to an oversized body', async () => {
    const w = world();
    expect((await w.call(payload, 'GET')).status).toBe(405);
    expect(await w.call(null)).toEqual({
      status: 400,
      body: { ok: false, error: 'body too large' },
    });
  });
});

describe('parsePayload', () => {
  const variant = (patch: Record<string, unknown>) => JSON.stringify({ ...payload, ...patch });

  it('accepts what the app actually sends', () => {
    const report: ErrorReport = {
      fingerprint: 'deadbeef',
      message: 'Something broke',
      stack: 'Error: Something broke\n    at f (index.bundle:1:2)',
      isFatal: false,
      context: 'gpx-import',
      breadcrumbs: ['opened library', 'tapped import'],
      count: 3,
      firstSeenAt: Date.UTC(2026, 9, 1),
      lastSeenAt: Date.UTC(2026, 9, 6),
      environment: { appVersion: '2.0.1', os: 'android 16', model: 'SM-S928B' },
    };
    const sent = buildReportPayload(report);
    expect(parsePayload(JSON.stringify(sent))).toEqual({
      fingerprint: sent.fingerprint,
      marker: sent.marker,
      title: sent.title,
      body: sent.body,
      comment: sent.comment,
    });
  });

  it.each([
    ['not JSON', '{nope', 'body must be JSON'],
    ['a non-object', '42', 'body must be an object'],
    ['a fingerprint that is not 8 hex', variant({ fingerprint: '../../x' }), 'bad fingerprint'],
    [
      'a marker for another fingerprint',
      variant({ marker: '[auto-report:ffffffff]' }),
      'bad marker',
    ],
    ['a title without the marker', variant({ title: 'Buy now' }), 'bad title'],
    ['a multi-line title', variant({ title: `${payload.marker} a\nb` }), 'bad title'],
    ['a title too long', variant({ title: `${payload.marker} ${'x'.repeat(200)}` }), 'bad title'],
    ['an empty body', variant({ body: '' }), 'bad body'],
    ['a body over the cap', variant({ body: 'x'.repeat(MAX_ISSUE_BODY + 1) }), 'bad body'],
    ['a free-form comment', variant({ comment: 'Visit example.com' }), 'bad comment'],
    ['a multi-line comment', variant({ comment: 'Seen again (x)\nspam' }), 'bad comment'],
  ])('refuses %s', (_name, text, error) => {
    expect(parsePayload(text)).toBe(error);
  });

  it('drops stray control characters instead of refusing the report', () => {
    const parsed = parsePayload(
      variant({ body: 'a\u0000b\tc\r\nd', title: `${payload.marker} a\u0007b` }),
    );
    expect(parsed).toMatchObject({ body: 'ab\tc\r\nd', title: `${payload.marker} ab` });
  });
});

describe('githubIssues', () => {
  it('calls the Issues API of the configured repo with the token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json(
        url.includes('?state=open') ? [{ number: 1, title: 'a' }, { nope: true }] : { id: 1 },
      );
    };
    const gh = githubIssues(fetchFn, 'tok', 'o/r');
    expect(await gh.listOpenIssues(100)).toEqual([{ number: 1, title: 'a' }]);
    await gh.createIssue('t', 'b');
    await gh.comment(5, 'c');
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET https://api.github.com/repos/o/r/issues?state=open&per_page=100&sort=created&direction=desc',
      'POST https://api.github.com/repos/o/r/issues',
      'POST https://api.github.com/repos/o/r/issues/5/comments',
    ]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ title: 't', body: 'b' });
  });

  it('turns GitHub failures into retryable statuses for the app', async () => {
    const gh = githubIssues(async () => new Response('x', { status: 403 }), 'tok', 'o/r');
    const error = await gh.createIssue('t', 'b').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(upstreamStatus(error)).toBe(503);
    expect(upstreamStatus(new GitHubError(500))).toBe(502);
    expect(upstreamStatus(new Error('network'))).toBe(502);
  });
});
