import { Directory, File, Paths } from 'expo-file-system';

/**
 * Where the stored heatmap lives (#500): `<cache>/heat/`. A cache, by the
 * platforms' rules — everything in it is regenerated from the library if the
 * OS purges it — but it survives restarts, so a warm launch reads it instead
 * of every trail's geometry.
 *
 * Flat directory of small files (see `@data/heatStore` for the names); the
 * manifest is written last, through a staged file, so a crash mid-batch
 * leaves the previous manifest in charge.
 */
export interface HeatStoreIO {
  readText(name: string): Promise<string | null>;
  readBytes(name: string): Promise<Uint8Array | null>;
  /** Replace a file's text. `atomic`: stage it and move it into place. */
  writeText(name: string, text: string, atomic?: boolean): void;
  writeBytes(name: string, bytes: Uint8Array): void;
  remove(name: string): void;
  /** Delete every stored file (a rebuild starts from nothing). */
  clear(): void;
}

const HEAT_DIR = 'heat';

function dir(): Directory {
  const d = new Directory(Paths.cache, HEAT_DIR);
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

function fileOf(name: string): File {
  return new File(dir(), name);
}

function replace(file: File, write: (f: File) => void): void {
  if (file.exists) file.delete();
  file.create();
  write(file);
}

/** The real, file-backed store directory. */
export function createHeatFileIO(): HeatStoreIO {
  return {
    async readText(name) {
      const f = fileOf(name);
      return f.exists ? f.text() : null;
    },
    async readBytes(name) {
      const f = fileOf(name);
      return f.exists ? f.bytes() : null;
    },
    writeText(name, text, atomic = false) {
      const target = fileOf(name);
      if (!atomic) {
        replace(target, (f) => f.write(text));
        return;
      }
      const staged = fileOf(`${name}.tmp`);
      replace(staged, (f) => f.write(text));
      if (target.exists) target.delete();
      staged.moveSync(target);
    },
    writeBytes(name, bytes) {
      replace(fileOf(name), (f) => f.write(bytes));
    },
    remove(name) {
      const f = fileOf(name);
      if (f.exists) f.delete();
    },
    clear() {
      const d = new Directory(Paths.cache, HEAT_DIR);
      if (d.exists) d.delete();
      d.create({ intermediates: true });
    },
  };
}
