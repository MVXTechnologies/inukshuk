import { createInvite, createTeam } from './actions';
import { generateDeviceKeys, type TeamCrypto } from './crypto';
import { makeJoinProof } from './invite';
import { TeamReplica } from './replica';
import { SyncSession, type Step } from './sync';
import { nobleCrypto } from './testing/noble';
import { nodeCrypto } from './testing/nodeCrypto';

const T0 = Date.UTC(2026, 9, 7, 12);

/** Deliver frames both ways until quiet. */
function pump(a: SyncSession, b: SyncSession, first: Step, now: number): void {
  let toB = first.send;
  let toA: Uint8Array[] = [];
  for (let i = 0; i < 50 && (toA.length > 0 || toB.length > 0); i++) {
    const nextA = toB.flatMap((f) => b.receive(f, now).send);
    const nextB = toA.flatMap((f) => a.receive(f, now).send);
    toA = nextA;
    toB = nextB;
  }
}

/**
 * The whole protocol on the shipped implementation, against a peer running the
 * other one: found a team, invite, join over a session, exchange messages.
 */
describe.each<[string, TeamCrypto, TeamCrypto]>([
  ['noble owner, node joiner', nobleCrypto, nodeCrypto],
  ['node owner, noble joiner', nodeCrypto, nobleCrypto],
  ['noble both', nobleCrypto, nobleCrypto],
])('end to end: %s', (_name, ownerC, joinerC) => {
  it('creates, invites, admits over a session, and both sides read each other', () => {
    const ownerKeys = generateDeviceKeys(ownerC);
    const team = createTeam(ownerC, ownerKeys, T0, { name: 'Traverse' });
    const owner = new TeamReplica(ownerC, team.teamId, ownerKeys, team.writer.cursor);
    owner.addKey(team.key);
    owner.ingest([team.genesis.env], T0);
    const inv = createInvite(ownerC, team.teamId, {
      expiresAt: T0 + 48 * 3600_000,
      maxUses: 1,
      role: 'member',
    });
    owner.control(T0 + 1, 'i.create', inv.body);
    owner.write(T0 + 2, 'msg', { id: 'm1', th: 'team', tx: 'welcome' });

    const joinerKeys = generateDeviceKeys(joinerC);
    const joiner = new TeamReplica(joinerC, team.teamId, joinerKeys);
    const proof = makeJoinProof(joinerC, inv.token, joinerKeys);
    const { session: a, step } = SyncSession.initiate(joinerC, joiner, { join: proof });
    const b = SyncSession.respond(ownerC, owner);
    pump(a, b, step, T0 + 60_000);

    expect(a.phase).toBe('open');
    expect(b.phase).toBe('open');
    expect(joiner.isActiveMember(joiner.id)).toBe(true);
    const welcome = [...joiner.data().entities.values()].find((e) => e.id === 'm1');
    expect(welcome?.state.fields['tx']?.value).toBe('welcome');
    expect(joiner.labels(joiner.log.logged().find((o) => o.env.t === 'm.genesis')!)).toEqual({
      name: 'Traverse',
    });

    const reply = joiner.write(T0 + 70_000, 'msg', { id: 'm2', th: 'team', tx: 'thanks' })!;
    for (const f of a.push([reply]).send) b.receive(f, T0 + 70_000);
    expect(owner.decode(owner.log.get(reply.id)!)).toMatchObject({ tx: 'thanks' });
  });
});
