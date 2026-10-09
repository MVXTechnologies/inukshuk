/**
 * Joining, over and over, with the real services, sessions and crypto on the
 * loopback mesh: no session may strike or fail to decrypt a frame.
 *
 * Twice in E2E (runs 37784108605, 37900582863) a join's first session lost a
 * frame: the founder struck once during the handshake, admitted the joiner,
 * then failed to decrypt the next sealed frame (closed(decrypt)). The redial
 * (meshLink) now recovers from that, but the frame loss itself never
 * reproduced here (600 joins, both crypto backends) nor in five traced E2E
 * reruns; this keeps watching for it, and the loopback trace (teamDebug) now
 * names strike reasons for the next E2E occurrence.
 */
import { SyncSession } from '@core/team/sync';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE, parseAnyInvite } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { LoopbackMeshHub } from './loopbackMesh';
import { MemoryTeamDisk } from './teamDisk';
import { TeamService } from './teamService';
import type { CreatedInvite } from './teamSession';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

const JOINS = 25;

/** Every strike and every session end, by side. */
const trace: string[] = [];
const proto = SyncSession.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const strike = proto['strike']!;
const finish = proto['finish']!;
beforeAll(() => {
  proto['strike'] = function (this: SyncSession, ...a: unknown[]) {
    trace.push(`strike ${String(a[1])} (${this.side}, ${this.phase})`);
    return strike.apply(this, a);
  };
  proto['finish'] = function (this: SyncSession, ...a: unknown[]) {
    trace.push(`end ${String(a[1])} (${this.side})`);
    return finish.apply(this, a);
  };
});
afterAll(() => {
  proto['strike'] = strike;
  proto['finish'] = finish;
});

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 2));
  }
  return true;
}

it(`admits a joiner ${JOINS} times in a row without a strike or a decrypt failure`, async () => {
  const problems: string[] = [];
  for (let i = 0; i < JOINS; i++) {
    trace.length = 0;
    const hub = new LoopbackMeshHub();
    const founder = new TeamService({
      c: nodeCrypto,
      disk: new MemoryTeamDisk(),
      transport: hub.createTransport(),
      tickMs: 0,
    });
    const session = await founder.createTeam({
      name: 'Relevé MSA',
      myName: 'Julie Tremblay',
      lifetimeMs: lifetimeMs('14d'),
    });
    await session.startMesh();
    const inv = session.createInvite({ ...DEFAULT_INVITE, uses: 5 }) as CreatedInvite;
    // What the simulated founder does before anyone joins: a message and a position.
    session.sendMessage('Départ 9 h au stationnement P2');
    session.updateRecord({
      prefs: { ...session.record.prefs, sharePosition: true, shareOnlyWhileRecording: false },
    });
    session.sharePosition({ latitude: 47, longitude: -71, accuracy: 6, at: Date.now() });

    const joiner = new TeamService({
      c: nodeCrypto,
      disk: new MemoryTeamDisk(),
      transport: hub.createTransport(),
      tickMs: 0,
    });
    const attempt = await joiner.startJoin(
      parseAnyInvite(`inukshuk://team/join?t=${inv.payload}`)!,
      'Marc',
    );
    const admitted = await until(() => attempt.state().phase === 'verify', 5_000);
    const bad = trace.filter((l) => l.startsWith('strike') || l.includes('decrypt'));
    if (!admitted || bad.length > 0) problems.push(`join ${i}: ${trace.join(', ')}`);
    await joiner.cancelJoin();
    await founder.deactivate();
  }
  expect(problems).toEqual([]);
});
