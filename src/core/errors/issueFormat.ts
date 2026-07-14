import { errorMarker } from './fingerprint';
import type { ErrorReport } from './types';

/**
 * Formatting of error reports into GitHub issue titles/bodies, "seen again"
 * comments, and the JSON payload for the optional relay endpoint. Pure string
 * building — the HTTP calls live in `src/lib/errorReporting`.
 *
 * There is deliberately no "open a pre-filled issue in the browser" URL: the
 * reporter is fully automatic and must never ask the end user to go to GitHub.
 * Without a delivery channel the queue simply waits on disk.
 */

const TITLE_MESSAGE_MAX = 80;

/**
 * GitHub rejects issue/comment bodies over 65 536 characters with a 422 — a
 * runaway stack would otherwise become a poison pill that blocks the queue. We
 * cap well under the limit.
 */
export const ISSUE_BODY_MAX = 60_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Single-line version of a (possibly multi-line) error message. */
function firstLine(message: string): string {
  return message.split('\n', 1)[0]?.trim() ?? '';
}

/**
 * Issue title: `[auto-report:<fp>] <message>`; the marker makes existing
 * issues findable for dedupe, the message makes the issue list scannable.
 */
export function buildIssueTitle(report: ErrorReport): string {
  return `${errorMarker(report.fingerprint)} ${truncate(firstLine(report.message), TITLE_MESSAGE_MAX)}`;
}

/** Markdown body for a newly filed issue. */
export function buildIssueBody(report: ErrorReport): string {
  const env = report.environment;
  const lines: string[] = [
    'Automatic error report from the app.',
    '',
    `> ${errorMarker(report.fingerprint)}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Fatal | ${report.isFatal ? 'yes' : 'no'} |`,
    ...(report.context !== undefined ? [`| Context | ${report.context} |`] : []),
    `| Occurrences | ${report.count} |`,
    `| First seen | ${new Date(report.firstSeenAt).toISOString()} |`,
    `| Last seen | ${new Date(report.lastSeenAt).toISOString()} |`,
    `| App version | ${env.appVersion} |`,
    ...(env.runtimeVersion !== undefined ? [`| Runtime version | ${env.runtimeVersion} |`] : []),
    ...(env.updateId !== undefined ? [`| Update id | ${env.updateId} |`] : []),
    `| OS | ${env.os} |`,
    ...(env.model !== undefined ? [`| Device | ${env.model} |`] : []),
    '',
    '### Message',
    '',
    '```',
    report.message,
    '```',
  ];
  if (report.stack !== undefined) {
    lines.push('', '### Stack', '', '```', report.stack, '```');
  }
  if (report.componentStack !== undefined) {
    lines.push('', '### Component stack', '', '```', report.componentStack.trim(), '```');
  }
  if (report.breadcrumbs.length > 0) {
    lines.push('', '### Breadcrumbs', '', ...report.breadcrumbs.map((b) => `- ${b}`));
  }
  return truncate(lines.join('\n'), ISSUE_BODY_MAX);
}

/** Comment added to the existing issue when the same fingerprint recurs. */
export function buildSeenAgainComment(report: ErrorReport): string {
  const env = report.environment;
  const device = env.model !== undefined ? `, ${env.model}` : '';
  return (
    `Seen again (x${report.count}, v${env.appVersion}, ${env.os}${device}) ` +
    `at ${new Date(report.lastSeenAt).toISOString()}.`
  );
}

/**
 * JSON payload POSTed to the optional relay endpoint (`extra.errorReportEndpoint`),
 * which files the issue server-side so no GitHub token has to be baked into the
 * binary. It carries both the raw report and the pre-rendered issue strings, so
 * a relay can be a dumb proxy (forward `title`/`body`) or do its own formatting.
 */
export interface ErrorReportPayload {
  fingerprint: string;
  marker: string;
  title: string;
  body: string;
  comment: string;
  report: ErrorReport;
}

export function buildReportPayload(report: ErrorReport): ErrorReportPayload {
  return {
    fingerprint: report.fingerprint,
    marker: errorMarker(report.fingerprint),
    title: buildIssueTitle(report),
    body: buildIssueBody(report),
    comment: buildSeenAgainComment(report),
    report,
  };
}
