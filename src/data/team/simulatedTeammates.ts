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
import type { CreatedInvite, TeamSession } from './teamSession';

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
  sharePhotoWithComment(session, center, bots.length);
  if (script) commentOnFirstSharedTrail(bot, script.photoComment);
  return true;
}

/** A 96 px rendered-terrain thumbnail (scripts/demo, no third-party image). */
const SIGN_THUMB =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCABgAGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCXy6PLrATVLtD8sxYD+8AasJrF0R0iPuVNdf1mJy+yZr+XR5dZZ1S8TkrAw9s/41NDrSsP3tuw9ShzTWIg+oOk0XvLo8uo49UsZOPO2H0YEVajkhk/1c0bfRga0VRPZk8pD5dHl1a8ujZT5hWKvl0eXVrZRso5gsVfLo8urWyjZRzBY4YuD0BFAfHFN8mUdUP40FHB+7+teXzLudXK+xMszLxnI96eJlBypx9KqncP4aQN6iiyY7tFtp0x0JppkjPITB9jiq28U4Pjo1Fg5n1LAmmH3GcD2Y1LFqF5GcpcSD6tkfrVRJCGyTxVtWiccMFJ7ChzcRqCZpW/iCZRi4iSQeqnBrSh1mxlA3M0Z9GX/CubIQ8LGPrikEanO3qPQ1SxEkN0Ds4ZIZxmGVH/AN05qXZXDBJUOQxXH0qeHV7+3OFuGYejfMP1raOIT3MnSaG79gwofp3x+lNd2GTkHPJ4zmstZnXo2Afeni5dW+VVP1FcPsmdHtS7JcZA+Vf++cVA0wJOUB/DFQNOH++gB9qaCB0PPWqULE+0ZM7Qt/CVPqKjIHUH86azD/8AUaQsOlWtCXqO3H1pQ3cE1GWzzT8jGOTVXJsyUXEgH3zS/aZe5z9ahIPqKQHnB5qbJle8i39rBGJI9w9jilW5QD5Y8Z96p856UobnPelyRGpyIwT1IBFJu9gtDeg/lTQoLYqzMcMGgnB/rQqhTnd0odz0WgBAFz1/KpFBY9DiocHbmgE/3TihoZbQKW9R3yKVgCOFUVXWRgetL5rDrUcrKUh5Bz/hTDuzyeKFlIzsIwafuVh6GmkDZEWI4/pSh8Dr+VIxwOlJx1OaqxN2BJcfKpA+tAXA6UbSDwfyp43/AN3ii4NEZXJ4WlJ29QCaHyG6UcnkDpQIGc44GKYGY8YpxYk8igEg55oGKEfqfypM465zTi+BwCaRcNy3egBe2QuRT1K4xhh7daZvI4ABFBJ4IApDHFQR8pB9jTNmOhP0pSd3VfxFLwRjnNAiUiNOp5pGcnoeKqsxLc09M9BRYbByTQqMO5oIINBdzximIUp6Hml3diRSIp7mgxDOaBDu3BqJ3xwBT9hFRlcGgY9VLClwehNNBIFAZjQAFcd6buYHrmpMkdRQyK3PQ0Af/9k=';

/**
 * Each simulated teammate shares a photo near me and comments on it, so a
 * photo thread exists for the flows (Team chat → Threads → the photo's card,
 * whose comment box must stay above the keyboard).
 */
function sharePhotoWithComment(
  session: {
    me: string;
    writeEntity: TeamSession['writeEntity'];
    commentOnPhoto: TeamSession['commentOnPhoto'];
  },
  center: { latitude: number; longitude: number },
  n: number,
): void {
  const id = `simph${n}${Date.now().toString(36)}`;
  const at = Date.now();
  session.writeEntity('photo', id, {
    trackId: `simtrail${n}`,
    lngLat: [center.longitude + 0.0015 * n, center.latitude + 0.001],
    placement: 'gps',
    takenAt: at,
    width: 96,
    height: 96,
    caption: 'Trail sign down',
  });
  session.writeEntity('photo', id, { tb: SIGN_THUMB });
  session.commentOnPhoto(id, 'The trail sign is down here');
  // Two more photos with 12 and 120 comments: the map's comment badges at two
  // and three characters ("12", "99+"), screenshotted by the flows.
  [12, 120].forEach((count, k) => {
    const pid = `${id}b${k}`;
    session.writeEntity('photo', pid, {
      trackId: `simtrail${n}`,
      lngLat: [center.longitude + 0.0015 * n + 0.0006 * (k + 1), center.latitude + 0.0006],
      placement: 'gps',
      takenAt: at + k + 1,
      width: 96,
      height: 96,
      caption: `Badge ${count}`,
    });
    session.writeEntity('photo', pid, { tb: SIGN_THUMB });
    for (let c = 0; c < count; c++) session.commentOnPhoto(pid, `Note ${c + 1}`);
  });
}

/**
 * The scripted guide: once a teammate's trail arrives with its photos, wait a
 * few seconds (looking at them…) and comment on the summit photo (its caption
 * says so), else the middle one.
 */
function commentOnFirstSharedTrail(bot: Bot, text: string): void {
  const session = bot.service.active;
  if (session === null) return;
  let last = -1;
  const timer = setInterval(() => {
    const theirs = session.photos().filter((p) => p.owner !== session.me && p.thumbUri !== null);
    // Wait until the whole trail has arrived (the count stopped growing).
    if (theirs.length === 0 || theirs.length !== last) {
      last = theirs.length;
      return;
    }
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
