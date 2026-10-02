/**
 * "Your organisation's maps aren't here?" — the Explore call to action that
 * invites clubs, parks, ZECs and outfitters to have their maps linked in the
 * catalog. Pure: the address, the prefilled GitHub issue link and the copy.
 *
 * Email is shown as text with a Copy button rather than a `mailto:` link:
 * many phones have no mail app configured and the link then silently does
 * nothing. The GitHub issue is a second, always-working path.
 */

export const ORG_MAPS_CONTACT_EMAIL = 'marc-andre.vigneault@mvxtechnologies.com';

const ISSUE_BASE = 'https://github.com/MVXTechnologies/inukshuk/issues/new';

export const ORG_MAPS_ISSUE_TITLE = 'Map source suggestion: ';

export const ORG_MAPS_ISSUE_BODY = [
  'Organisation:',
  'Where the maps are published (link):',
  'Area covered:',
  'Licence or terms of use (if known):',
  '',
  'Inukshuk links to the publisher’s own downloads — it never rehosts maps.',
].join('\n');

/** The prefilled "new issue" URL for a map-source suggestion. */
export function orgMapsIssueUrl(): string {
  const q = (v: string) => encodeURIComponent(v);
  return `${ISSUE_BASE}?title=${q(ORG_MAPS_ISSUE_TITLE)}&body=${q(ORG_MAPS_ISSUE_BODY)}`;
}

export const ORG_MAPS_COPY = {
  title: 'Your organisation’s maps aren’t here?',
  body: 'Clubs, parks, ZECs and outfitters: write to us and we’ll link your maps in Explore.',
  copy: 'Copy',
  copied: 'Copied',
  github: 'Suggest on GitHub',
} as const;
