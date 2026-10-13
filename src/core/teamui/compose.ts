/**
 * Composing a team message (#589 UI): who it goes to and who it mentions.
 * Audiences use the core's selectors (`roles.ts`): roles, a group subtree,
 * a group's leads, every lead. Pure.
 */
import type { Audience } from '@core/team/roles';

import type { GroupRow, MemberRow } from './view';

export interface AudienceChoice {
  id: string;
  label: string;
  /** Undefined = the whole team. */
  aud: Audience | undefined;
}

export function audienceChoices(groups: readonly GroupRow[]): AudienceChoice[] {
  const out: AudienceChoice[] = [
    { id: 'all', label: 'Everyone', aud: undefined },
    { id: 'admins', label: 'Admins', aud: { r: ['admin', 'owner'] } },
  ];
  if (groups.length > 0) out.push({ id: 'leads', label: 'All group leads', aud: { l: true } });
  for (const g of groups) {
    out.push({ id: `g:${g.id}`, label: g.name, aud: { g: [g.id] } });
    out.push({ id: `l:${g.id}`, label: `${g.name} leads`, aud: { g: [g.id], l: true } });
  }
  return out;
}

/**
 * Members mentioned as `@Name` (case-insensitive; the longest name wins, so
 * "@Julie Tremblay" beats "@Julie"). Never me, never removed members.
 */
export function findMentions(text: string, members: readonly MemberRow[]): string[] {
  const lower = text.toLocaleLowerCase();
  const found = new Set<string>();
  const candidates = members
    .filter((m) => m.active && !m.isMe && m.named)
    .sort((a, b) => b.name.length - a.name.length);
  let i = lower.indexOf('@');
  while (i >= 0) {
    const rest = lower.slice(i + 1);
    const hit = candidates.find((m) => {
      const name = m.name.toLocaleLowerCase();
      if (!rest.startsWith(name)) return false;
      const next = rest.charAt(name.length);
      return next === '' || !/[\p{L}\p{N}]/u.test(next);
    });
    if (hit) found.add(hit.id);
    i = lower.indexOf('@', i + 1);
  }
  return [...found].slice(0, 32);
}
