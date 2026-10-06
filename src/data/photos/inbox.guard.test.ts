import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stage-2 tripwire (#587): the resize inbox (`.photo-inbox/`) is served by the
 * loopback server and holds full-resolution copies of picked photos, EXIF and
 * GPS included. `unstage` removes each one after its job, but a crash or a
 * kill mid-import leaves them there. `clearPhotoInbox()` must therefore run
 * at app launch, before the first import can start.
 *
 * Stage 1 has no UI, so nothing can call it yet. This test fails as soon as
 * any app code (outside `src/data/photos`) starts using the resizer or the
 * inbox WITHOUT some app code also calling `clearPhotoInbox()`.
 */

const ROOT = join(__dirname, '..', '..', '..');
const SCAN = ['app', 'src'];
const OWN_DIR = join('src', 'data', 'photos');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...sources(rel));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

describe('photo inbox is cleared at launch (stage 2 requirement)', () => {
  const files = SCAN.flatMap(sources).filter((rel) => !rel.startsWith(OWN_DIR));
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

  it('scans the app sources', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('any app code that resizes photos is matched by a launch-time clearPhotoInbox()', () => {
    const users = files.filter((rel) =>
      /\b(createWebViewResizer|stageForResize|commitPhotoImport)\b/.test(read(rel)),
    );
    const clears = files.filter((rel) => /\bclearPhotoInbox\s*\(/.test(read(rel)));
    // TODO(#587 stage 2): call clearPhotoInbox() from the launch path (next to
    // the other startup housekeeping) when the Add-photos UI lands.
    if (users.length > 0) expect(clears).not.toEqual([]);
  });
});
