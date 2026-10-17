import { DomainRegistry, KIND_NAME, recordKey, type DomainPlugin } from './registry';

const plugin = (id: string, kinds: string[], threads?: string[]): DomainPlugin => ({
  id,
  kinds,
  ...(threads ? { threads } : {}),
  owned: () => false,
  validate: () => true,
  authorize: () => ({ owner: undefined }),
});

describe('DomainRegistry', () => {
  it('dispatches kinds and threads to the plug-in that registered them; unknown → undefined', () => {
    const a = plugin('team', ['wpt', 'comment'], ['team', 'pin']);
    const b = plugin('lib', ['lfo', 'lit']);
    const r = new DomainRegistry([a, b]);
    expect(r.forKind('wpt')).toBe(a);
    expect(r.forKind('lit')).toBe(b);
    expect(r.forKind('pnm')).toBeUndefined();
    expect(r.forThread('team')).toBe(a);
    expect(r.forThread(`pin:${'A'.repeat(43)}:p1`)).toBe(a);
    expect(r.forThread('dm:x')).toBeUndefined();
    expect(r.plugin('lib')).toBe(b);
    expect(r.plugin('self')).toBeUndefined();
    expect(r.plugins()).toEqual([a, b]);
    expect(r.kinds()).toEqual(['comment', 'lfo', 'lit', 'wpt']);
  });

  it('never resolves a prototype member as a kind, thread or domain', () => {
    const r = new DomainRegistry([plugin('team', ['wpt'])]);
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(r.forKind(k)).toBeUndefined();
      expect(r.forThread(k)).toBeUndefined();
      expect(r.plugin(k)).toBeUndefined();
    }
  });

  it('refuses a kind or thread claimed twice (across or within plug-ins) and a domain id reused', () => {
    const r = new DomainRegistry([plugin('team', ['wpt'], ['team'])]);
    expect(() => r.register(plugin('lib', ['wpt']))).toThrow(
      "kind 'wpt' claimed by 'team' and 'lib'",
    );
    expect(() => r.register(plugin('lib', ['lit', 'lit']))).toThrow("kind 'lit' claimed");
    expect(() => r.register(plugin('lib', ['lit'], ['team']))).toThrow("thread 'team' claimed");
    expect(() => r.register(plugin('lib', ['lit'], ['x', 'x']))).toThrow("thread 'x' claimed");
    expect(() => r.register(plugin('team', ['lit']))).toThrow("domain 'team' registered twice");
    // A refused plug-in left nothing behind.
    expect(r.forKind('lit')).toBeUndefined();
    expect(r.forThread('x')).toBeUndefined();
    expect(r.plugin('lib')).toBeUndefined();
  });

  it('refuses malformed kind names, thread prefixes and domain ids', () => {
    const r = new DomainRegistry();
    expect(() => r.register(plugin('Team', ['wpt']))).toThrow("bad domain id 'Team'");
    expect(() => r.register(plugin('lib', ['toolongkind']))).toThrow("bad kind 'toolongkind'");
    expect(() => r.register(plugin('lib', ['l1']))).toThrow("bad kind 'l1'");
    expect(() => r.register(plugin('lib', ['lit'], ['pin:']))).toThrow("bad thread prefix 'pin:'");
    expect(r.plugins()).toEqual([]);
  });

  it('a frozen registry takes no more plug-ins', () => {
    const r = new DomainRegistry([plugin('team', ['wpt'])]);
    expect(r.isFrozen).toBe(false);
    expect(r.freeze()).toBe(r);
    expect(r.isFrozen).toBe(true);
    expect(() => r.register(plugin('lib', ['lit']))).toThrow('registry is frozen');
    expect(r.forKind('wpt')?.id).toBe('team');
  });

  it('kind names: 1–8 lowercase letters (every v1 kind fits)', () => {
    for (const k of ['wpt', 'comment', 'gmeta', 'a', 'abcdefgh'])
      expect(KIND_NAME.test(k)).toBe(true);
    for (const k of ['', 'abcdefghi', 'Wpt', 'w-t', 'w1', 'msg '])
      expect(KIND_NAME.test(k)).toBe(false);
  });

  it('record keys: owned kinds carry the owner, shared ones do not', () => {
    expect(recordKey(true, 'comment', 'c1', 'M')).toBe('comment:M:c1');
    expect(recordKey(true, 'comment', 'c1')).toBe('comment::c1');
    expect(recordKey(false, 'wpt', 'w1', 'M')).toBe('wpt:w1');
  });
});
