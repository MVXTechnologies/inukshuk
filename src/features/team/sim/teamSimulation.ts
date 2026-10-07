/**
 * A live team simulation (demo builds only, `EXPO_PUBLIC_MESH_LOOPBACK=1`;
 * never in a store build: every entry point requires this module behind that
 * inlined flag, so Metro drops it from release bundles).
 *
 * 3–4 simulated teammates, each a full `TeamService` with its own replica,
 * keys and on-disk log (`SimBotDisk`), joined to MY active team over the
 * in-memory loopback mesh: every message, pin, task tick and position is a
 * real signed op through the core, and my phone notifies through the real
 * alert path. They:
 * - walk my nearby trails (shared or in my Library), else the Mont-Sainte-Anne
 *   trail, sharing a position every ~15 s;
 * - answer chat messages and @mentions within 5–20 s (rule-based, FR/EN);
 * - acknowledge tasks given to them, walk toward the anchor and tick them
 *   done after 30–90 s ("Fait ✔", on the photo when it is a photo task);
 * - now and then drop a pin, comment on a shared photo or share a waypoint;
 * - answer my pins and my photo comments.
 *
 * Timers run at ×1 or ×5. Bot work is queued one action at a time after
 * interactions (`InteractionManager`) so signing and verifying never land in
 * the middle of a gesture; frame gaps are sampled while it runs (the panel
 * shows them). The state (running, speed, who joined, what was handled)
 * persists, so a restarted app resumes the same teammates.
 */
import { DEFAULT_INVITE } from '@core/teamui/invites';
import { anchorInfo, type AnchorLookup } from '@core/teamui/tasks';
import type { TeamTask } from '@core/team/tasks';
import { sharedLoopbackHub } from '@data/team';
import { teamCrypto } from '@data/team/teamCrypto';
import { TeamService } from '@data/team/teamService';
import type { TeamSession } from '@data/team/teamSession';
import { peekTrackGeometry } from '@data/trackGeometry';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { teamService } from '@state/teamStore';
import { InteractionManager } from 'react-native';
import { create } from 'zustand';

import {
  ACK_TASK,
  CHATTER,
  DONE_TASK,
  pick,
  PHOTO_LINES,
  PIN_LINES,
  PIN_REPLIES,
  replyTo,
  WAYPOINT_NAMES,
} from './responder';
import { useTeamMapFocus } from '../map/teamMapFocus';
import { metres, pointAlong, routesNear, stepToward } from './routes';
import { deleteSimDisks, readJsonFile, SimBotDisk, simStateFile, writeJsonFile } from './simDisk';

interface BotSpec {
  key: string;
  name: string;
  role: 'admin' | 'member' | 'guest';
}

export const CREW: readonly BotSpec[] = [
  { key: 'alex', name: 'Alex (Guide)', role: 'admin' },
  { key: 'julie', name: 'Julie Tremblay', role: 'member' },
  { key: 'sam', name: 'Sam', role: 'member' },
];
export const GUEST: BotSpec = { key: 'lea', name: 'Léa (invitée)', role: 'guest' };

const WALK_MPS = 1.3;
const SHARE_EVERY_MS = 15_000;
const TICK_MS = 1_000;

interface Persisted {
  running: boolean;
  speed: 1 | 5;
  teamId: string | null;
  joined: string[];
  handled: string[];
}

export interface SimStatus {
  running: boolean;
  speed: 1 | 5;
  busy: string | null;
  bots: { key: string; name: string; online: boolean }[];
  /** Frame gaps while running (ms): p95 and worst over the last minute. */
  frameP95: number | null;
  frameMax: number | null;
  log: string[];
}

export const useSimStatus = create<SimStatus>(() => ({
  running: false,
  speed: 1,
  busy: null,
  bots: [],
  frameP95: null,
  frameMax: null,
  log: [],
}));

interface Bot {
  spec: BotSpec;
  service: TeamService;
  session: TeamSession;
  route: readonly (readonly [number, number])[];
  dist: number;
  pos: [number, number];
  target: [number, number] | null;
  lastShare: number;
}

const rnd = Math.random;
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);

class Simulation {
  private state: Persisted = { running: false, speed: 1, teamId: null, joined: [], handled: [] };
  private bots: Bot[] = [];
  private handled = new Set<string>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private queue: Promise<void> = Promise.resolve();
  private nextAmbient = 0;
  private frames: number[] = [];
  private raf: number | null = null;

  // ── Persistence ────────────────────────────────────────────────────────

  private load(): void {
    const s = readJsonFile<Persisted>(simStateFile());
    if (s) this.state = { ...this.state, ...s };
    this.handled = new Set(this.state.handled);
    useSimStatus.setState({ speed: this.state.speed });
  }

  private save(): void {
    this.state.handled = [...this.handled].slice(-600);
    writeJsonFile(simStateFile(), this.state);
  }

  private note(line: string): void {
    const log = [`${new Date().toLocaleTimeString()} ${line}`, ...useSimStatus.getState().log];
    useSimStatus.setState({ log: log.slice(0, 12) });
  }

  private publish(): void {
    useSimStatus.setState({
      running: this.state.running,
      speed: this.state.speed,
      bots: this.bots.map((b) => ({ key: b.spec.key, name: b.spec.name, online: true })),
    });
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  /** Run `fn` after `ms` (scaled by the speed), then queued after interactions. */
  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.run(fn);
    }, ms / this.state.speed);
    this.timers.add(t);
  }

  /** One bot action at a time, after any running gesture or animation. */
  private run(fn: () => void): void {
    this.queue = this.queue.then(
      () =>
        new Promise<void>((resolve) => {
          InteractionManager.runAfterInteractions(() => {
            try {
              if (this.state.running) fn();
            } catch (e) {
              this.note(`error: ${(e as Error).message}`);
            }
            setTimeout(resolve, 120);
          });
        }),
    );
  }

  private sampleFrames(): void {
    let last = 0;
    const loop = (t: number) => {
      if (last > 0) {
        this.frames.push(t - last);
        if (this.frames.length > 3600) this.frames.splice(0, this.frames.length - 3600);
      }
      last = t;
      this.raf = this.state.running ? requestAnimationFrame(loop) : null;
    };
    this.raf = requestAnimationFrame(loop);
  }

  private reportFrames(): void {
    if (this.frames.length < 30) return;
    const s = [...this.frames].sort((a, b) => a - b);
    useSimStatus.setState({
      frameP95: Math.round(s[Math.floor(s.length * 0.95)] ?? 0),
      frameMax: Math.round(s[s.length - 1] ?? 0),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  private human(): TeamSession | null {
    return teamService()?.active ?? null;
  }

  private routes(): (readonly [number, number])[][] {
    const me = this.human();
    const here = useSettingsStore.getState().lastKnownPosition;
    const at: [number, number] | null = here ? [here.longitude, here.latitude] : null;
    const lines: [number, number][][] = [];
    for (const tr of me?.shares().tracks ?? []) lines.push(...tr.parts);
    for (const t of useLibraryStore.getState().tracks) {
      const box = t.stats.bbox;
      if (!box || !at) continue;
      if (at[1] < box.minLat - 0.05 || at[1] > box.maxLat + 0.05) continue;
      if (at[0] < box.minLng - 0.07 || at[0] > box.maxLng + 0.07) continue;
      const g = peekTrackGeometry(t);
      if (g) lines.push(...g.parts);
    }
    return routesNear(at, lines);
  }

  private async openBot(spec: BotSpec, teamId: string): Promise<Bot | null> {
    const c = teamCrypto();
    if (c === null) return null;
    const service = new TeamService({
      c,
      disk: new SimBotDisk(spec.key),
      transport: sharedLoopbackHub().createTransport(),
    });
    await service.load();
    if (!service.teams.some((t) => t.teamId === teamId)) return null;
    const session = await service.activate(teamId);
    await session.startMesh();
    return this.wrap(spec, service, session);
  }

  private wrap(spec: BotSpec, service: TeamService, session: TeamSession): Bot {
    session.updateRecord({
      prefs: { ...session.record.prefs, sharePosition: true, shareOnlyWhileRecording: false },
    });
    const routes = this.routes();
    const i = this.bots.length;
    const route = routes[i % routes.length]!;
    const dist = 250 * i + rnd() * 200;
    return {
      spec,
      service,
      session,
      route,
      dist,
      pos: pointAlong(route, dist),
      target: null,
      lastShare: 0,
    };
  }

  private async joinBot(spec: BotSpec): Promise<Bot | null> {
    const me = this.human();
    const c = teamCrypto();
    if (me === null || c === null) return null;
    const inv = me.createInvite({
      ...DEFAULT_INVITE,
      role: spec.role === 'guest' ? 'guest' : 'member',
    });
    if (typeof inv === 'string') {
      this.note(`invite failed: ${inv}`);
      return null;
    }
    const service = new TeamService({
      c,
      disk: new SimBotDisk(spec.key),
      transport: sharedLoopbackHub().createTransport(),
    });
    await service.load();
    const attempt = await service.startJoin(inv.token, spec.name);
    const end = Date.now() + 20_000;
    while (attempt.state().phase !== 'verify') {
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
    const session = await service.confirmJoin();
    if (typeof session === 'string') return null;
    await session.startMesh();
    const end2 = Date.now() + 10_000;
    while (session.view().members.length < 2 && Date.now() < end2) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (spec.role === 'admin') me.setRole(session.me, 'admin');
    return this.wrap(spec, service, session);
  }

  /** Resume after an app restart (if it was running). */
  async resume(): Promise<void> {
    this.load();
    if (!this.state.running) return;
    this.state.running = false; // start() sets it once the bots are back
    await this.start();
  }

  async start(): Promise<void> {
    if (this.state.running || useSimStatus.getState().busy) return;
    const me = this.human();
    if (me === null) {
      this.note('Open or create a team first');
      return;
    }
    useSimStatus.setState({ busy: 'Starting…' });
    try {
      if (this.state.teamId !== me.teamId) {
        // Another team: these teammates join it afresh.
        await this.dispose();
        deleteSimDisks();
        this.state = {
          running: false,
          speed: this.state.speed,
          teamId: me.teamId,
          joined: [],
          handled: [],
        };
        this.handled.clear();
      }
      const wanted = [...CREW, ...(this.state.joined.includes(GUEST.key) ? [GUEST] : [])];
      for (const spec of wanted) {
        if (this.bots.some((b) => b.spec.key === spec.key)) continue;
        useSimStatus.setState({ busy: `${spec.name}…` });
        const bot = this.state.joined.includes(spec.key)
          ? await this.openBot(spec, me.teamId)
          : await this.joinBot(spec);
        if (bot) {
          this.bots.push(bot);
          if (!this.state.joined.includes(spec.key)) {
            this.state.joined.push(spec.key);
            bot.session.sendMessage(
              spec.role === 'admin' ? 'Salut la gang, je suis là 👋' : `Bonjour, ici ${spec.name}`,
            );
          }
        } else {
          this.note(`${spec.name} could not join`);
        }
      }
      // Everything already there counts as seen: only new things get answers.
      this.markAllHandled();
      this.state.running = true;
      this.nextAmbient = Date.now() + between(60_000, 120_000) / this.state.speed;
      this.save();
      this.tick = setInterval(() => this.onTick(), TICK_MS);
      this.sampleFrames();
      // Show where they are: the map flies to the first teammate.
      const first = this.bots[0];
      if (first) useTeamMapFocus.getState().focus(first.pos[0], first.pos[1], 14);
      this.note('Simulation running');
    } finally {
      useSimStatus.setState({ busy: null });
      this.publish();
    }
  }

  async stop(): Promise<void> {
    this.state.running = false;
    this.save();
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    await this.dispose();
    this.note('Simulation stopped');
    this.publish();
  }

  private async dispose(): Promise<void> {
    for (const b of this.bots.splice(0)) {
      await b.service.deactivate();
    }
  }

  setSpeed(speed: 1 | 5): void {
    this.state.speed = speed;
    this.save();
    this.publish();
  }

  /** "Make someone send a message now." */
  pokeMessage(): void {
    const b = this.bots.length > 0 ? pick(rnd, this.bots) : null;
    if (!b) return;
    this.run(() => {
      b.session.sendMessage(pick(rnd, CHATTER));
      this.note(`${b.spec.name} wrote in the chat`);
    });
  }

  async addGuest(): Promise<void> {
    if (!this.state.running || this.bots.some((b) => b.spec.key === GUEST.key)) return;
    useSimStatus.setState({ busy: `${GUEST.name}…` });
    try {
      const bot = await this.joinBot(GUEST);
      if (bot) {
        this.bots.push(bot);
        this.state.joined.push(GUEST.key);
        this.save();
        bot.session.sendMessage('Bonjour! Merci de m’avoir invitée');
      }
    } finally {
      useSimStatus.setState({ busy: null });
      this.publish();
    }
  }

  // ── Behaviour ──────────────────────────────────────────────────────────

  private markAllHandled(): void {
    for (const b of this.bots) {
      for (const k of this.eventKeys(b)) this.handled.add(k);
    }
  }

  private eventKeys(b: Bot): string[] {
    const s = b.session;
    return [
      ...s.view().messages.map((m) => `${b.spec.key}:msg:${m.key}`),
      ...s.tasks().map((t) => `${b.spec.key}:task:${t.owner}:${t.id}`),
      ...s
        .pins()
        .flatMap((p) =>
          p.messages.map((m) => `${b.spec.key}:pin:${p.owner}:${p.id}:${m.author}:${m.id}`),
        ),
      ...s.photos().map((p) => `${b.spec.key}:photo:${p.owner}:${p.id}`),
      ...[...s.photoThreads().entries()].flatMap(([pid, said]) =>
        said.map((x) => `${b.spec.key}:pc:${pid}:${x.author}:${x.at}`),
      ),
    ];
  }

  private fresh(key: string): boolean {
    if (this.handled.has(key)) return false;
    this.handled.add(key);
    return true;
  }

  private onTick(): void {
    const me = this.human();
    if (!this.state.running || me === null) return;
    const now = Date.now();
    const step = WALK_MPS * (TICK_MS / 1000) * this.state.speed;
    for (const b of this.bots) {
      if (b.target) b.pos = stepToward(b.pos, b.target, step * 1.4);
      else {
        b.dist += step;
        b.pos = pointAlong(b.route, b.dist);
      }
      if (now - b.lastShare >= SHARE_EVERY_MS / this.state.speed) {
        b.lastShare = now;
        const pos = b.pos;
        this.run(() =>
          b.session.sharePosition({
            latitude: pos[1],
            longitude: pos[0],
            accuracy: 5,
            at: Date.now(),
          }),
        );
      }
    }
    let changed = false;
    for (const b of this.bots) changed = this.react(b, me.me) || changed;
    if (now >= this.nextAmbient) {
      this.nextAmbient = now + between(180_000, 360_000) / this.state.speed;
      this.ambient();
    }
    if (changed) this.save();
    if (now % 10_000 < TICK_MS) this.reportFrames();
  }

  /** New things this bot should answer. Returns whether anything was handled. */
  private react(b: Bot, human: string): boolean {
    const s = b.session;
    let any = false;
    const lead = this.bots[0] === b;
    // Chat: a mention always gets an answer from the one mentioned; otherwise
    // the lead picks one teammate to answer (sometimes nobody).
    for (const m of s.view().messages) {
      if (!this.fresh(`${b.spec.key}:msg:${m.key}`)) continue;
      any = true;
      if (m.author !== human) continue;
      const first = b.spec.name.split(/[\s(]/)[0]!.toLocaleLowerCase();
      if (m.mentionsMe || m.text.toLocaleLowerCase().includes(`@${first}`)) {
        this.reply(b, m.text, true);
      } else if (lead && m.priority >= 0) {
        const who = pick(rnd, this.bots);
        this.reply(who, m.text, false);
      }
    }
    // Tasks given to me.
    for (const t of s.tasks()) {
      if (!this.fresh(`${b.spec.key}:task:${t.owner}:${t.id}`)) continue;
      any = true;
      if (t.assignee === s.me && !t.done && t.owner !== s.me) this.takeTask(b, t);
    }
    // Pins: someone's new pin, or a reply on mine.
    for (const p of s.pins()) {
      for (const msg of p.messages) {
        if (!this.fresh(`${b.spec.key}:pin:${p.owner}:${p.id}:${msg.author}:${msg.id}`)) continue;
        any = true;
        if (msg.author !== human) continue;
        const onMine = p.owner === s.me;
        if (onMine || (lead && msg.id === p.id && rnd() < 0.8)) {
          const who = onMine ? b : pick(rnd, this.bots);
          this.later(between(8_000, 25_000), () => {
            who.session.replyToPin(p.owner, p.id, pick(rnd, PIN_REPLIES));
            this.note(`${who.spec.name} answered a pin`);
          });
        }
      }
    }
    // Photos: my new trail photos get a comment now and then; my comments get answers.
    const newMine = s
      .photos()
      .filter((ph) => this.fresh(`${b.spec.key}:photo:${ph.owner}:${ph.id}`))
      .filter((ph) => ph.owner === human);
    if (newMine.length > 0) any = true;
    if (lead && newMine.length > 0) {
      // A trail shared with photos: the guide looks and comments on its summit
      // photo (else the middle one); now and then someone else on another.
      const summit =
        newMine.find((ph) => /sommet|summit|top/i.test(ph.caption ?? '')) ??
        newMine[Math.floor(newMine.length / 2)]!;
      this.later(between(12_000, 25_000), () => {
        b.session.commentOnPhoto(summit.id, 'Superbe vue au sommet ! On repart à 14 h?');
        this.note(`${b.spec.name} commented on the summit photo`);
      });
      const other = newMine.find((ph) => ph !== summit);
      if (other && rnd() < 0.5) {
        const who =
          pick(
            rnd,
            this.bots.filter((x) => x !== b),
          ) ?? b;
        this.later(between(30_000, 60_000), () => {
          who.session.commentOnPhoto(other.id, pick(rnd, PHOTO_LINES));
          this.note(`${who.spec.name} commented on a photo`);
        });
      }
    }
    for (const [pid, said] of s.photoThreads()) {
      for (const x of said) {
        if (!this.fresh(`${b.spec.key}:pc:${pid}:${x.author}:${x.at}`)) continue;
        any = true;
        if (lead && x.author === human && rnd() < 0.6) {
          const who = pick(rnd, this.bots);
          this.later(between(6_000, 20_000), () => {
            who.session.commentOnPhoto(pid, pick(rnd, PIN_REPLIES));
            this.note(`${who.spec.name} answered on a photo`);
          });
        }
      }
    }
    return any;
  }

  private reply(b: Bot, text: string, mentioned: boolean): void {
    const line = replyTo(text, mentioned, rnd);
    if (line === null) return;
    this.later(between(5_000, 20_000), () => {
      b.session.sendMessage(line);
      this.note(`${b.spec.name}: ${line}`);
    });
  }

  private lookup(s: TeamSession): AnchorLookup {
    return {
      photo: (o, id) => {
        const p = s.photos().find((x) => x.owner === o && x.id === id);
        return p ? { lng: p.lng, lat: p.lat, caption: p.caption } : undefined;
      },
      pin: (o, id) => {
        const p = s.pins().find((x) => x.owner === o && x.id === id);
        return p ? { lng: p.lng, lat: p.lat, text: p.messages[0]?.text ?? '' } : undefined;
      },
      trail: (o, id) => {
        const tr = s.shares().tracks.find((x) => x.owner === o && x.id === id);
        return tr ? { name: tr.name, start: tr.parts[0]?.[0] ?? null } : undefined;
      },
    };
  }

  /** Say where the task came from that I'm on it; walk there; tick it. */
  private takeTask(b: Bot, t: TeamTask): void {
    const s = b.session;
    const say = (text: string) => {
      const src = t.source;
      const a = t.anchor;
      if (a?.kind === 'photo') s.commentOnPhoto(a.id, text);
      else if (src && a?.kind === 'pin') s.replyToPin(a.owner, a.id, text);
      else s.sendMessage(`${text} — « ${t.title} »`);
    };
    this.later(between(5_000, 15_000), () => {
      say(pick(rnd, ACK_TASK));
      this.note(`${b.spec.name} took “${t.title}”`);
      const at = anchorInfo(t.anchor, this.lookup(s)).at;
      if (at) b.target = [at[0], at[1]];
    });
    this.later(between(30_000, 90_000), () => {
      const arrived = b.target === null || metres(b.pos, b.target) < 40;
      if (b.target && !arrived) b.pos = b.target; // close enough for a demo
      s.setTaskDone(t.owner, t.id, true);
      say(pick(rnd, DONE_TASK));
      b.target = null;
      this.note(`${b.spec.name} finished “${t.title}”`);
    });
  }

  /** Now and then: a pin off the trail, a photo comment, or a waypoint. */
  private ambientCount = 0;

  private ambient(): void {
    if (this.bots.length === 0) return;
    // The first one is the guide's pin off the trail (the demo's story).
    const first = this.ambientCount++ === 0;
    const b = first ? this.bots[0]! : pick(rnd, this.bots);
    const roll = first ? 0 : rnd();
    const photos = b.session.photos();
    this.run(() => {
      if (roll < 0.5 || (roll < 0.8 && photos.length === 0)) {
        const off = between(60, 150) / 111_320;
        const [lng, lat] = b.pos;
        const e = b.session.dropPin(
          lng + off * (rnd() < 0.5 ? -1 : 1),
          lat + off,
          pick(rnd, PIN_LINES),
        );
        this.note(e ? `pin failed: ${e}` : `${b.spec.name} dropped a pin`);
      } else if (roll < 0.8) {
        b.session.commentOnPhoto(pick(rnd, photos).id, pick(rnd, PHOTO_LINES));
        this.note(`${b.spec.name} commented on a photo`);
      } else if (b.spec.role !== 'guest') {
        b.session.shareWaypoint({
          latitude: b.pos[1],
          longitude: b.pos[0],
          label: pick(rnd, WAYPOINT_NAMES),
        });
        this.note(`${b.spec.name} shared a waypoint`);
      }
    });
  }

  /** Stop and forget the simulated teammates (they stay listed in the team as members). */
  async reset(): Promise<void> {
    await this.stop();
    deleteSimDisks();
    this.state = { running: false, speed: 1, teamId: null, joined: [], handled: [] };
    this.handled.clear();
    useSimStatus.setState({ log: [], frameP95: null, frameMax: null });
    this.publish();
  }
}

export const teamSimulation = new Simulation();
