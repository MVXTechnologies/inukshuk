import {
  ALLOW_ALL,
  DISALLOW_ALL,
  isAllowed,
  parseRobots,
  robotsFromStatus,
  robotsPatternMatches,
} from './robots';

const TOKEN = 'InukshukCatalogBot';

/** cartespleinair.org/robots.txt as read on 2026-10-14. */
const SITE = `User-Agent: *
Allow: /
Disallow: /admin
Disallow: /login
Disallow: /auth
Disallow: /en/admin
Disallow: /en/login
Disallow: /en/auth
Disallow: /api

Sitemap: https://cartespleinair.org/sitemap.xml`;

describe('parseRobots', () => {
  it('lets the crawler read the listing and the map pages, never the API', () => {
    const policy = parseRobots(SITE, TOKEN);
    expect(isAllowed(policy, '/cartes')).toBe(true);
    expect(isAllowed(policy, '/cartes/riviere-desert-x-2023')).toBe(true);
    expect(isAllowed(policy, '/api/explore/rivers/assets/1/overview')).toBe(false);
    expect(isAllowed(policy, '/admin')).toBe(false);
  });

  it('prefers the group naming our product token over *', () => {
    const body = `User-agent: *
Disallow: /

User-agent: inukshukcatalogbot
Disallow: /private
Crawl-delay: 5`;
    const policy = parseRobots(body, TOKEN);
    expect(policy.crawlDelaySec).toBe(5);
    expect(isAllowed(policy, '/cartes')).toBe(true);
    expect(isAllowed(policy, '/private/x')).toBe(false);
  });

  it('groups consecutive user-agent lines and ignores comments and junk', () => {
    const body = `# hello
Disallow: /orphan
User-agent: OtherBot
User-agent: *   # everyone
Disallow: /x # comment
Crawl-delay: soon
nonsense line
Allow:
Disallow:`;
    const policy = parseRobots(body, TOKEN);
    expect(policy.rules).toEqual([{ allow: false, path: '/x' }]);
    expect(policy.crawlDelaySec).toBeUndefined();
    expect(isAllowed(policy, '/orphan')).toBe(true);
  });

  it('allows everything when no group applies', () => {
    expect(parseRobots('User-agent: OtherBot\nDisallow: /', TOKEN)).toEqual(ALLOW_ALL);
  });
});

describe('isAllowed', () => {
  it('lets the longest rule win, Allow on a tie', () => {
    const policy = {
      rules: [
        { allow: false, path: '/cartes' },
        { allow: true, path: '/cartes/' },
        { allow: false, path: '/x' },
        { allow: true, path: '/x' },
      ],
    };
    expect(isAllowed(policy, '/cartes')).toBe(false);
    expect(isAllowed(policy, '/cartes/a')).toBe(true);
    expect(isAllowed(policy, '/x')).toBe(true);
  });

  it('understands * and $', () => {
    expect(robotsPatternMatches('/*.pdf$', '/maps/a.pdf')).toBe(true);
    expect(robotsPatternMatches('/*.pdf$', '/maps/a.pdf?x=1')).toBe(false);
    expect(robotsPatternMatches('/api/*?*', '/api/x?q=1')).toBe(true);
    expect(robotsPatternMatches('/a.b', '/aXb')).toBe(false);
  });
});

describe('robotsFromStatus (RFC 9309)', () => {
  it('reads a 2xx, allows all on a 4xx, disallows all when unreachable', () => {
    expect(isAllowed(robotsFromStatus(200, SITE, TOKEN), '/api')).toBe(false);
    // assets.cartespleinair.org answers robots.txt with 403 (S3).
    expect(robotsFromStatus(403, '', TOKEN)).toEqual(ALLOW_ALL);
    expect(robotsFromStatus(503, '', TOKEN)).toEqual(DISALLOW_ALL);
    expect(robotsFromStatus(null, '', TOKEN)).toEqual(DISALLOW_ALL);
    expect(isAllowed(DISALLOW_ALL, '/cartes')).toBe(false);
  });
});
