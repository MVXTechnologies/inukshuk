/**
 * Simulated teammates for loopback builds (`EXPO_PUBLIC_MESH_LOOPBACK=1`,
 * dev and E2E only — never a store build): other "phones" on the in-memory
 * hub, each a full `TeamService` with its own memory disk, so the team UI and
 * the Maestro flows exercise the real join, sync, message and removal paths
 * on one device.
 */
import { DEFAULT_INVITE, parseAnyInvite } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { sharedLoopbackHub } from './index';
import { teamCrypto } from './teamCrypto';
import { MemoryTeamDisk } from './teamDisk';
import { TeamService } from './teamService';
import type { CreatedInvite } from './teamSession';

interface Bot {
  name: string;
  service: TeamService;
  timer: ReturnType<typeof setInterval> | null;
}

const bots: Bot[] = [];

function newBot(name: string): Bot {
  const c = teamCrypto();
  if (c === null) throw new Error('No CSPRNG in this build');
  const service = new TeamService({
    c,
    disk: new MemoryTeamDisk(),
    transport: sharedLoopbackHub().createTransport(),
  });
  const bot: Bot = { name, service, timer: null };
  bots.push(bot);
  return bot;
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/** Walk around `center`, sharing a position every few seconds. */
function walk(bot: Bot, center: { latitude: number; longitude: number }, seed: number): void {
  const session = bot.service.active;
  if (session === null) return;
  session.updateRecord({
    prefs: { ...session.record.prefs, sharePosition: true, shareOnlyWhileRecording: false },
  });
  let step = 0;
  const share = () => {
    // ~11 m per 5 s: a brisk walk round a ~900 m loop.
    const a = seed + step++ / 40;
    session.sharePosition({
      latitude: center.latitude + 0.004 * Math.sin(a),
      longitude: center.longitude + 0.006 * Math.cos(a * 0.8),
      accuracy: 6,
      at: Date.now(),
    });
  };
  share();
  bot.timer = setInterval(share, 5_000);
}

/**
 * A simulated phone joins MY team with an invite I created (any payload
 * form), then says hello and starts sharing a walk near `center`.
 */
export async function addSimulatedTeammate(
  invite: CreatedInvite | string,
  name: string,
  center: { latitude: number; longitude: number },
  script?: { photoComment: string },
): Promise<boolean> {
  const token = typeof invite === 'string' ? parseAnyInvite(invite) : invite.token;
  if (token === undefined) return false;
  const bot = newBot(name);
  const attempt = await bot.service.startJoin(token, name);
  if (!(await until(() => attempt.state().phase === 'verify', 15_000))) return false;
  const session = await bot.service.confirmJoin();
  if (typeof session === 'string') return false;
  await session.startMesh();
  await until(() => session.view().members.length > 1, 5_000);
  session.sendMessage(`Bonjour, ici ${name}`);
  walk(bot, center, bots.length);
  if (script) commentOnFirstSharedTrail(bot, script.photoComment);
  return true;
}

/**
 * The scripted guide: once a teammate's trail arrives with its photos, wait a
 * few seconds (looking at them…) and comment on the summit photo (its caption
 * says so), else the middle one.
 */
function commentOnFirstSharedTrail(bot: Bot, text: string): void {
  const session = bot.service.active;
  if (session === null) return;
  const timer = setInterval(() => {
    const theirs = session.photos().filter((p) => p.owner !== session.me && p.thumbUri !== null);
    if (theirs.length === 0) return;
    clearInterval(timer);
    const pick =
      theirs.find((p) => /sommet|summit/i.test(p.caption ?? '')) ??
      theirs[Math.floor(theirs.length / 2)]!;
    setTimeout(() => session.commentOnPhoto(pick.id, text), 6_000);
  }, 1_000);
}

/**
 * A simulated team, founded by a simulated owner, waiting for me to join:
 * returns the invite link to open (the Join screen takes it).
 */
export async function simulatedTeamToJoin(center: {
  latitude: number;
  longitude: number;
}): Promise<{ link: string; payload: string } | null> {
  const bot = newBot('Julie Tremblay');
  const session = await bot.service.createTeam({
    name: 'Relevé MSA',
    myName: 'Julie Tremblay',
    lifetimeMs: lifetimeMs('14d'),
  });
  await session.startMesh();
  const inv = session.createInvite({ ...DEFAULT_INVITE, uses: 5 });
  if (typeof inv === 'string') return null;
  session.sendMessage('Départ 9 h au stationnement P2');
  walk(bot, center, 3);
  return { link: `inukshuk://team/join?t=${inv.payload}`, payload: inv.payload };
}

export function simulatedTeammateCount(): number {
  return bots.length;
}

/** Stop every simulated phone. */
export async function stopSimulatedTeammates(): Promise<void> {
  for (const bot of bots.splice(0)) {
    if (bot.timer) clearInterval(bot.timer);
    await bot.service.deactivate();
  }
}
