import {
  canGrantRole,
  canManage,
  canSetParent,
  canUsePriority,
  canWriteData,
  groupDepth,
  inAudience,
  isWithin,
  MAX_GROUP_DEPTH,
  parseAudience,
  parseGroupLinks,
  type AudienceSubject,
} from './roles';
import { device } from './testing/fixtures';

const tree = new Map<string, string | undefined>([
  ['event', undefined],
  ['north', 'event'],
  ['n1', 'north'],
  ['south', 'event'],
]);
const subject = (
  role: AudienceSubject['role'],
  groups: AudienceSubject['groups'] = [],
  id = 'me',
): AudienceSubject => ({ id, role, groups });

describe('authority ladder', () => {
  it('owner > admin > member > guest', () => {
    expect(canGrantRole('owner', 'admin')).toBe(true);
    expect(canGrantRole('owner', 'owner')).toBe(false);
    expect(canGrantRole('admin', 'admin')).toBe(false);
    expect(canGrantRole('admin', 'guest')).toBe(true);
    expect(canGrantRole('member', 'guest')).toBe(false);
    expect(canManage('owner', 'admin')).toBe(true);
    expect(canManage('owner', 'owner')).toBe(false);
    expect(canManage('admin', 'admin')).toBe(false);
    expect(canManage('admin', 'member')).toBe(true);
    expect(canManage('guest', 'guest')).toBe(false);
    expect(canWriteData('guest', 'pos')).toBe(true);
    // Entity writes pass the op-type gate; the data fold narrows guests to their own comments.
    expect(canWriteData('guest', 'e.set')).toBe(true);
    expect(canWriteData('guest', 'g.set')).toBe(false);
    expect(canWriteData('member', 'e.set')).toBe(true);
  });
});

describe('groups', () => {
  it('walks the tree with bounded depth', () => {
    expect(isWithin(tree, 'n1', 'event')).toBe(true);
    expect(isWithin(tree, 'n1', 'south')).toBe(false);
    expect(groupDepth(tree, 'n1')).toBe(3);
    expect(groupDepth(tree, 'missing')).toBe(Infinity);
    const loop = new Map<string, string | undefined>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(isWithin(loop, 'a', 'zzz')).toBe(false);
    expect(groupDepth(loop, 'a')).toBe(Infinity);
  });

  it('refuses cycles and over-deep subtrees', () => {
    expect(canSetParent(tree, 'south', 'north')).toBe(true);
    expect(canSetParent(tree, 'event', 'n1')).toBe(false);
    expect(canSetParent(tree, 'south', 'nope')).toBe(false);
    const chain = new Map<string, string | undefined>([['g0', undefined]]);
    for (let i = 1; i < MAX_GROUP_DEPTH; i++) chain.set(`g${i}`, `g${i - 1}`);
    chain.set('top', undefined);
    chain.set('kid', 'top');
    expect(canSetParent(chain, 'top', `g${MAX_GROUP_DEPTH - 1}`)).toBe(false); // would push 'kid' too deep
  });

  it('parses member links strictly', () => {
    expect(parseGroupLinks(undefined)).toEqual([]);
    expect(parseGroupLinks([{ g: 'a', lead: true }, { g: 'b' }])).toEqual([
      { g: 'a', lead: true },
      { g: 'b' },
    ]);
    for (const bad of [
      5,
      [{ g: 'a' }, { g: 'a' }],
      [{ g: 'a', lead: false }],
      [{ g: 'a', x: 1 }],
      [{}],
      new Array(17).fill({ g: 'a' }),
    ]) {
      expect(parseGroupLinks(bad)).toBeUndefined();
    }
  });
});

describe('audiences', () => {
  const id = device().id;

  it('parses to a canonical form and refuses junk', () => {
    expect(parseAudience({ g: ['b', 'a', 'a'], l: true })).toEqual({ g: ['a', 'b'], l: true });
    expect(parseAudience({ r: ['admin'], m: [id] })).toEqual({ r: ['admin'], m: [id] });
    for (const bad of [
      {},
      null,
      [],
      { x: 1 },
      { m: [] },
      { m: ['x'] },
      { r: ['king'] },
      { g: [] },
      { g: ['a b'] },
      { l: false },
      { m: 5 },
    ]) {
      expect(parseAudience(bad)).toBeUndefined();
    }
  });

  it('matches by id, role, group subtree and leadership', () => {
    const member = subject('member', [{ g: 'n1' }]);
    const lead = subject('member', [{ g: 'north', lead: true }], 'lead');
    expect(inAudience(undefined, member, tree)).toBe(true);
    expect(inAudience({ m: ['me'] }, member, tree)).toBe(true);
    expect(inAudience({ r: ['admin'] }, member, tree)).toBe(false);
    expect(inAudience({ g: ['north'] }, member, tree)).toBe(true); // subtree
    expect(inAudience({ g: ['south'] }, member, tree)).toBe(false);
    expect(inAudience({ g: ['event'], l: true }, member, tree)).toBe(false);
    expect(inAudience({ g: ['event'], l: true }, lead, tree)).toBe(true);
    expect(inAudience({ l: true }, lead, tree)).toBe(true);
    expect(inAudience({ l: true }, member, tree)).toBe(false);
    // A link to a deleted group counts for nothing.
    expect(inAudience({ g: ['event'] }, subject('member', [{ g: 'gone' }]), tree)).toBe(false);
  });

  it('priority: urgent for admins anywhere, for leads only inside their own groups', () => {
    const lead = subject('member', [{ g: 'north', lead: true }]);
    expect(canUsePriority(subject('guest'), 1, undefined, tree)).toBe(false);
    expect(canUsePriority(subject('member'), 0, undefined, tree)).toBe(true);
    expect(canUsePriority(subject('member'), 1, undefined, tree)).toBe(true);
    expect(canUsePriority(subject('member'), 2, undefined, tree)).toBe(false);
    expect(canUsePriority(subject('admin'), 2, undefined, tree)).toBe(true);
    expect(canUsePriority(lead, 2, { g: ['n1'] }, tree)).toBe(true);
    expect(canUsePriority(lead, 2, { g: ['north'] }, tree)).toBe(true);
    expect(canUsePriority(lead, 2, { g: ['south'] }, tree)).toBe(false);
    expect(canUsePriority(lead, 2, { g: ['n1'], r: ['admin'] }, tree)).toBe(false);
    expect(canUsePriority(lead, 2, undefined, tree)).toBe(false);
  });
});
