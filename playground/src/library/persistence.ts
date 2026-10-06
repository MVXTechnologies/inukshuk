export interface LibraryWrite<T> {
  index: T;
  files: Map<string, string | null>;
  replace: boolean;
}
export type PersistenceStatus = { state: 'saved' | 'saving' | 'error'; message?: string };

/** Retain session edits until one atomic write acknowledges the latest revision. */
export class LibraryPersistence<T> {
  status: PersistenceStatus = { state: 'saved' };
  private revision = 0;
  private pending: LibraryWrite<T> | undefined;
  private memory = new Map<string, string | null>();
  private saving: Promise<boolean> | undefined;
  constructor(
    private commit: (write: LibraryWrite<T>) => Promise<void>,
    private changed: (status: PersistenceStatus) => void = () => {},
  ) {}
  stage(index: T, files = new Map<string, string | null>(), replace = false): void {
    this.revision++;
    if (replace) this.memory.clear();
    for (const [id, xml] of files) this.memory.set(id, xml);
    this.pending = {
      index,
      files: new Map([...(replace ? [] : (this.pending?.files ?? [])), ...files]),
      replace: replace || (this.pending?.replace ?? false),
    };
  }
  read(id: string): string | null | undefined {
    return this.memory.get(id) ?? (this.memory.has(id) || this.pending?.replace ? null : undefined);
  }
  private publish(status: PersistenceStatus): void {
    this.status = status;
    this.changed(status);
  }
  save(): Promise<boolean> {
    if (this.saving) return this.saving;
    this.saving = this.flush().then((saved) => {
      this.saving = undefined;
      // A caller can stage another revision after flush resolves but before
      // this handoff runs. Include that write (and its outcome) in the promise
      // already shared with callers, rather than acknowledging it unsaved.
      return saved && this.pending ? this.save() : saved;
    });
    return this.saving;
  }
  private async flush(): Promise<boolean> {
    if (!this.pending) return true;
    this.publish({ state: 'saving' });
    try {
      while (this.pending) {
        const revision = this.revision;
        await this.commit(this.pending);
        if (revision === this.revision) this.pending = undefined;
      }
      this.publish({ state: 'saved' });
      return true;
    } catch (error) {
      this.publish({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
