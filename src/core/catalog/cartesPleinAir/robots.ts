/**
 * robots.txt, per RFC 9309, for the catalog crawler (#680).
 *
 * - The group whose `User-agent` token matches ours (case-insensitive prefix
 *   of our product token) wins; otherwise the `*` group; otherwise no rules.
 * - Within a group the longest matching path rule wins, `Allow` on a tie.
 *   `*` matches any run of characters and a trailing `$` anchors the end.
 * - `Crawl-delay` (not in the RFC, but common) is honoured when it asks for
 *   more than our own interval.
 *
 * What an unreadable robots.txt means is the caller's call ({@link robotsFromStatus}):
 * RFC 9309 says a 4xx is "no restrictions" and a 5xx or network failure is
 * "assume complete disallow" until it can be read.
 */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  /** Seconds, when the matching group asks for one. */
  crawlDelaySec?: number;
}

/** Everything allowed (a 4xx robots.txt, or a file with no group for us). */
export const ALLOW_ALL: RobotsPolicy = { rules: [] };
/** Nothing allowed (robots.txt unreachable: RFC 9309 §2.3.1.4). */
export const DISALLOW_ALL: RobotsPolicy = { rules: [{ allow: false, path: '/' }] };

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySec?: number;
}

/** Parse robots.txt and pick the group that applies to `productToken` (e.g. "InukshukCatalogBot"). */
export function parseRobots(body: string, productToken: string): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow means "allow everything": it adds no rule.
      if (value !== '') current.rules.push({ allow: key === 'allow', path: value });
    } else if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySec = seconds;
    }
  }

  const token = productToken.toLowerCase();
  const pick =
    groups.find((g) => g.agents.some((a) => a !== '*' && token.startsWith(a))) ??
    groups.find((g) => g.agents.includes('*'));
  if (pick === undefined) return ALLOW_ALL;
  return {
    rules: pick.rules,
    ...(pick.crawlDelaySec !== undefined ? { crawlDelaySec: pick.crawlDelaySec } : {}),
  };
}

/** The policy for a robots.txt that answered `status` with `body`. */
export function robotsFromStatus(
  status: number | null,
  body: string,
  productToken: string,
): RobotsPolicy {
  if (status !== null && status >= 200 && status < 300) return parseRobots(body, productToken);
  if (status !== null && status >= 400 && status < 500) return ALLOW_ALL;
  return DISALLOW_ALL;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Does a robots path pattern match this path (path + query)? */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(escapeRegex).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/** May we fetch this path (path + query, e.g. "/cartes?x=1")? */
export function isAllowed(policy: RobotsPolicy, path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of policy.rules) {
    if (!robotsPatternMatches(rule.path, path)) continue;
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best === null || best.allow;
}
