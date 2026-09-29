import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Regression fence for the 2026-09-28 dead-map-tap bug.
 *
 * React Native recycles its synthetic events: once a handler yields — its
 * first `await` — the event's `nativeEvent` is `null`. MapScreen's async
 * onMapPress read `e.nativeEvent.lngLat` after awaiting the camera projection,
 * so with the point bubble or any waypoint pin on screen every tap lost its
 * coordinate: the bubble could not be closed, and after "Add waypoint" no tap
 * could open one again. Nothing failed loudly — the read is just `undefined`.
 *
 * This reads the source tree and fails for any async function whose FIRST
 * parameter is read as `<param>.nativeEvent` (or `<param>?.nativeEvent`)
 * after an `await` in its body. The fix is to copy what you need before the
 * first await — for MapLibre presses, `readMapPress` (@core/map/mapTap) in the
 * synchronous handler, and pass the copy to the async body.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const ROOTS = ['src/features', 'src/ui', 'app'].map((r) => join(REPO_ROOT, r));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Drop comments so prose about the bug never counts as a read. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The body `{ … }` that starts at or after `from`, brace-matched. */
function bodyAfter(src: string, from: number): string | null {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** `async (e…) => { … }` bodies that read `e.nativeEvent` after an await. */
export function lateEventReads(source: string): string[] {
  const src = stripComments(source);
  const found: string[] = [];
  const head = /async\s*\(\s*(\w+)\b[^)]*\)[^=]*=>/g;
  for (let m = head.exec(src); m !== null; m = head.exec(src)) {
    const param = m[1] ?? '';
    const body = bodyAfter(src, m.index + m[0].length);
    if (!body) continue;
    const firstAwait = body.search(/\bawait\b/);
    if (firstAwait < 0) continue;
    const read = new RegExp(`\\b${param}\\s*\\??\\.\\s*nativeEvent\\b`);
    if (read.test(body.slice(firstAwait))) found.push(`async (${param}) at offset ${m.index}`);
  }
  return found;
}

describe('async event handlers copy the event before awaiting', () => {
  it('detects the 2026-09-28 shape (self-test)', () => {
    const buggy = `
      const onMapPress = useCallback(
        async (e: { nativeEvent?: { point?: [number, number] } }) => {
          const point = e.nativeEvent?.point;
          await map.project([0, 0]);
          const lngLat = e.nativeEvent?.lngLat;
        },
        [],
      );`;
    const fine = `
      const onMapPress = useCallback(
        async (e: { nativeEvent?: { point?: [number, number] } }) => {
          const point = e.nativeEvent?.point;
          const lngLat = e.nativeEvent?.lngLat;
          await map.project([0, 0]);
        },
        [],
      );`;
    expect(lateEventReads(buggy)).toHaveLength(1);
    expect(lateEventReads(fine)).toEqual([]);
  });

  it('finds no event read after an await anywhere in the app', () => {
    const offenders = ROOTS.flatMap(sourceFiles).flatMap((file) =>
      lateEventReads(readFileSync(file, 'utf8')).map(
        (hit) => `${file.slice(REPO_ROOT.length + 1)}: ${hit}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps MapScreen on the copying wrapper', () => {
    const src = stripComments(
      readFileSync(join(REPO_ROOT, 'src/features/map/MapScreen.tsx'), 'utf8'),
    );
    expect(src).toMatch(/const press = readMapPress\(e\)/);
    expect(src).toMatch(/onPress=\{onMapPress\}/);
  });
});
