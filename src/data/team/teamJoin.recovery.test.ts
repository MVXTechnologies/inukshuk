/**
 * What a join loses when its first session dies on a frame that fails to
 * decrypt: nothing, only time. The joiner's link dials the same teammate
 * again after its backoff (meshLink, 2 s first), the second session admits it
 * and the log sync brings the team's message, task and position.
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

const ends: { side: string; why: string; at: number }[] = [];
const proto = SyncSession.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const finish = proto['finish']!;
beforeAll(() => {
  proto['finish'] = function (this: SyncSession, ...a: unknown[]) {
    ends.push({ side: this.side, why: String(a[1]), at: Date.now() });
    return finish.apply(this, a);
  };
});
afterAll(() => {
  proto['finish'] = finish;
});

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

const isJson = (frame: Uint8Array): boolean => {
  try {
    JSON.parse(new TextDecoder().decode(frame));
    return true;
  } catch {
    return false;
  }
};

it('recovers everything after a session dies on a decrypt failure, ~2 s later', async () => {
  const hub = new LoopbackMeshHub();
  const founderTransport = hub.createTransport();
  // The founder's first sealed frame to the joiner arrives damaged: the
  // joiner cannot decrypt it, before it ever saw the team's log.
  const send = founderTransport.send.bind(founderTransport);
  let damaged = false;
  founderTransport.send = (peerId, frame) => {
    if (!damaged && !isJson(frame)) {
      damaged = true;
      const bad = frame.slice();
      bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
      return send(peerId, bad);
    }
    return send(peerId, frame);
  };
  const founder = new TeamService({
    c: nodeCrypto,
    disk: new MemoryTeamDisk(),
    transport: founderTransport,
    tickMs: 0,
  });
  const team = await founder.createTeam({
    name: 'Relevé MSA',
    myName: 'Julie Tremblay',
    lifetimeMs: lifetimeMs('14d'),
  });
  await team.startMesh();
  const inv = team.createInvite({ ...DEFAULT_INVITE, uses: 5 }) as CreatedInvite;
  team.sendMessage('Départ 9 h au stationnement P2');
  expect(team.createTask({ title: 'Check the culvert at km 2', assignee: team.me })).toBeNull();
  team.updateRecord({
    prefs: { ...team.record.prefs, sharePosition: true, shareOnlyWhileRecording: false },
  });
  team.sharePosition({ latitude: 47.07, longitude: -70.9, accuracy: 6, at: Date.now() });

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
  expect(await until(() => ends.some((e) => e.why === 'decrypt'), 3_000)).toBe(true);
  const brokeAt = ends.find((e) => e.why === 'decrypt')!.at;
  expect(attempt.state().phase).not.toBe('verify');

  // The redial: same teammate, after the 2 s backoff; admitted on the second session.
  expect(await until(() => attempt.state().phase === 'verify', 6_000)).toBe(true);
  const delay = Date.now() - brokeAt;
  expect(delay).toBeGreaterThanOrEqual(1_900);
  expect(delay).toBeLessThan(4_000);

  const session = await joiner.confirmJoin();
  if (typeof session === 'string') throw new Error(session);
  await session.startMesh();
  // Nothing written before the failure is lost.
  expect(
    await until(
      () =>
        session.view().messages.some((m) => m.text === 'Départ 9 h au stationnement P2') &&
        session.tasks().some((t) => t.title === 'Check the culvert at km 2') &&
        session.positions().some((p) => p.name === 'Julie Tremblay'),
      5_000,
    ),
  ).toBe(true);
  await joiner.deactivate();
  await founder.deactivate();
}, 20_000);
