/**
 * The replica as a sync session sees it, with write-ahead persistence (#589,
 * spec §12b). A `SyncSession` calls `ingest` and `admit` and then returns the
 * frames to send; the replica may author ops of its own inside those calls
 * (an `m.admit` for a joiner, an admin's automatic `k.rotate` after a raced
 * invite). This wrapper appends every newly stored op to the disk log — this
 * device's own first, then the cursor — synchronously, before the call
 * returns, so nothing this device signed can leave it without being on disk.
 */
import type { SignedOp } from '@core/team/envelope';
import type { JoinProof } from '@core/team/invite';
import type { IngestReport, TeamReplica } from '@core/team/replica';
import type { SyncStore } from '@core/team/sync';

import type { TeamDisk } from './teamDisk';

export class PersistingStore implements SyncStore {
  /** Called after any change with the ops newly stored (logged and ephemeral). */
  onStored: ((ops: SignedOp[]) => void) | null = null;

  constructor(
    readonly replica: TeamReplica,
    private readonly disk: TeamDisk,
  ) {}

  get teamId() {
    return this.replica.teamId;
  }
  get keys() {
    return this.replica.keys;
  }
  get id() {
    return this.replica.id;
  }
  get state() {
    return this.replica.state;
  }
  versionVector() {
    return this.replica.versionVector();
  }
  opsInRange(author: string, from: number, to: number) {
    return this.replica.opsInRange(author, from, to);
  }
  liveEphemeral(now: number) {
    return this.replica.liveEphemeral(now);
  }
  isActiveMember(memberId: string) {
    return this.replica.isActiveMember(memberId);
  }
  flush(now: number) {
    this.track(() => {
      this.replica.flush(now);
      return { result: undefined, accepted: [] };
    });
  }

  ingest(raws: readonly unknown[], now: number): IngestReport {
    return this.track(() => {
      const report = this.replica.ingest(raws, now);
      return { result: report, accepted: report.accepted };
    }).result;
  }

  admit(proof: JoinProof, now: number): { op: SignedOp } | { error: string } {
    return this.track(() => ({ result: this.replica.admit(proof, now), accepted: [] })).result;
  }

  /**
   * Run a replica mutation (local authoring included) and persist what it
   * stored: `accepted` is what the call reports storing (a peer's batch);
   * this device's own new ops are found by the writer's seq, whatever path
   * signed them (a local action, an admit, an automatic rotation).
   */
  track<T>(fn: () => { result: T; accepted: readonly SignedOp[] }): {
    result: T;
    stored: SignedOp[];
  } {
    const before = this.replica.writer.cursor.seq;
    const { result, accepted } = fn();
    const after = this.replica.writer.cursor.seq;
    const mine = after > before ? this.replica.opsInRange(this.replica.id, before + 1, after) : [];
    const ids = new Set(mine.map((op) => op.id));
    const others = accepted.filter((op) => op.env.sq > 0 && !ids.has(op.id));
    // Own ops first, then the cursor that points at them, then the rest.
    if (mine.length > 0) {
      this.disk.appendOps(
        this.teamId,
        mine.map((op) => op.env),
      );
      this.disk.saveCursor(this.teamId, this.replica.writer.cursor);
    }
    if (others.length > 0) {
      this.disk.appendOps(
        this.teamId,
        others.map((op) => op.env),
      );
    }
    const stored = [...mine, ...accepted.filter((op) => !ids.has(op.id))];
    if (stored.length > 0) this.onStored?.(stored);
    return { result, stored };
  }
}
