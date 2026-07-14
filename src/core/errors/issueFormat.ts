import { errorMarker } from './fingerprint';
import type { ErrorReport } from './types';

/**
 * Formatting of error reports into GitHub issue titles/bodies, "seen again"
 * comments, and the pre-filled `issues/new` URL used when no API token is
 * configured. Pure string building — the HTTP calls live in
 * `src/lib/errorReporting`.
 */

const TITLE_MESSAGE_MAX = 80;

/** Keep the manual-report URL comfortably under browser/Android intent limits. */
const MANUAL_URL_BODY_MAX = 4000;

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
  return lines.join('\n');
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
 * Pre-filled `issues/new` URL for the manual (token-less) fallback. The body
 * is truncated so the URL stays within what browsers/intents accept.
 */
export function buildManualReportUrl(repo: string, report: ErrorReport): string {
  const title = encodeURIComponent(buildIssueTitle(report));
  const body = encodeURIComponent(truncate(buildIssueBody(report), MANUAL_URL_BODY_MAX));
  return `https://github.com/${repo}/issues/new?title=${title}&body=${body}`;
}
