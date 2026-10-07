import { audienceChoices, findMentions } from './compose';
import type { GroupRow, MemberRow } from './view';

const member = (id: string, name: string, extra: Partial<MemberRow> = {}): MemberRow => ({
  id,
  name,
  named: true,
  initials: '',
  color: '',
  role: 'member',
  active: true,
  isMe: false,
  groups: [],
  joinedAt: 0,
  via: 'admit',
  left: false,
  lastSeenAt: null,
  actions: { promote: null, demote: null, remove: false, setGroup: false },
  ...extra,
});

describe('compose', () => {
  const members = [
    member('a', 'Julie'),
    member('b', 'Julie Tremblay'),
    member('c', 'Ana Ruiz'),
    member('me', 'Marc', { isMe: true }),
    member('x', 'Luc', { active: false }),
  ];

  it('finds mentions, longest name first, never me or removed members', () => {
    expect(findMentions('@julie tremblay tu prends les rubans?', members)).toEqual(['b']);
    expect(findMentions('Merci @Julie, @Ana Ruiz!', members)).toEqual(['a', 'c']);
    expect(findMentions('@Marc @Luc @Juliette', members)).toEqual([]);
    expect(findMentions('no mention', members)).toEqual([]);
  });

  it('offers the core audiences', () => {
    const groups: GroupRow[] = [{ id: 'crew', name: 'Trail crew', parent: null, depth: 0, members: 2 }];
    expect(audienceChoices([]).map((c) => c.label)).toEqual(['Everyone', 'Admins']);
    expect(audienceChoices(groups).map((c) => [c.label, c.aud])).toEqual([
      ['Everyone', undefined],
      ['Admins', { r: ['admin', 'owner'] }],
      ['All group leads', { l: true }],
      ['Trail crew', { g: ['crew'] }],
      ['Trail crew leads', { g: ['crew'], l: true }],
    ]);
  });
});
