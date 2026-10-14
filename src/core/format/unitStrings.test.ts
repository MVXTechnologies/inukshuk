/**
 * Guard (#702): every distance, height, speed and pace the app prints goes
 * through `@core/format` (`./units.ts`), so the Units setting reaches it.
 *
 * This scans the app's source for text that glues a unit onto a number by
 * hand — `${d} km`, `{x} m` in JSX, `+ ' ft'` — and fails on any file not
 * on the list below. If it fails on your change, format through
 * `formatDistance` / `formatElevation` / `formatSpeed` / `formatPace` /
 * `formatAccuracy` (or `@state/formatters`) instead of adding the file here.
 * A file goes on the list only when its values must stay in one unit, with
 * the reason.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const SCAN = ['src', 'app'];

const UNIT = String.raw`(?:km\/h|km|mph|kn|NM|nmi|mi|ft|m)(?![\w²³/])`;
/** An interpolation (template or JSX) followed by a space and a unit: `${d} km`, `{d} m`. */
const AFTER_VALUE = new RegExp(String.raw`\}[ \u00a0]${UNIT}`);
/**
 * A bare figure paired with a formatted one — `{Math.round(first)} →
 * {formatElevation(last)}` (QA 2.6.1): the left end has no unit, so it
 * stayed in metres in imperial.
 */
const BARE_BESIDE_FORMATTED = new RegExp(
  String.raw`\{(?:Math\.(?:round|floor|ceil)\([^}]*\)|[\w.]+\.toFixed\([^}]*\))\}[ \u00a0]*(?:→|–|—|-|to)[ \u00a0]*\{format`,
);
/** A string literal that is just a spaced unit, for concatenation: `' km'`, `" ft"`. */
const SPACED_LITERAL = new RegExp(String.raw`['"\`][ \u00a0]${UNIT}['"\`]`);

/** Files whose figures stay in one unit on purpose — path prefix → why. */
const ALLOWED: Record<string, string> = {
  'src/core/format/units.ts': 'the formatter itself',
  'src/core/convert/': 'coordinate conversion: survey values are SI by definition',
  'src/core/geodetic/': 'survey marks: official published heights, in metres',
  'src/core/gnss/': 'GNSS receiver accuracies and heights: survey-grade metres',
  'src/features/gnss/': 'RTK baseline: survey-grade kilometres',
  'src/core/tides/card.ts': 'tide datum table: official published datum offsets, in metres',
  'src/core/tides/tidalBenchmark.ts': 'tidal benchmark: official published heights, in metres',
  'src/core/mapmaker/': 'the printed sheet: a metric UTM grid and scale bar',
  'src/features/map/mapmaker/': 'the printed sheet and its contour interval (metric data)',
  'src/features/map/components/terrainOverlayControls.tsx':
    'contour interval chips: the contour data is cut at metric intervals',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__fixtures__' || name === '__snapshots__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|\.d\.ts$|testUtils\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** Offending lines (comments skipped) of one file's text. */
function rawUnitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .filter(
      (line) =>
        AFTER_VALUE.test(line) || SPACED_LITERAL.test(line) || BARE_BESIDE_FORMATTED.test(line),
    );
}

describe('unit strings guard (#702)', () => {
  it('catches the hand-glued shapes it is meant to', () => {
    expect(rawUnitLines('const s = `${d} km`;')).toHaveLength(1);
    expect(rawUnitLines('return `${(m / 1000).toFixed(1)} km`;')).toHaveLength(1);
    expect(rawUnitLines('<Text>{value} m</Text>')).toHaveLength(1);
    expect(rawUnitLines("label = n + ' ft';")).toHaveLength(1);
    expect(rawUnitLines('`${speed} km/h`')).toHaveLength(1);
    expect(rawUnitLines('`${d} NM`')).toHaveLength(1);
    // A raw figure as one end of a formatted range (QA 2.6.1, the recording panel).
    expect(rawUnitLines('{Math.round(first)} → {formatElevation(last)}')).toHaveLength(1);
    expect(rawUnitLines('{lo.toFixed(0)} – {formatDistance(hi)}')).toHaveLength(1);
  });

  it('leaves other units, identifiers and comments alone', () => {
    expect(rawUnitLines('`${n} min`')).toEqual([]);
    expect(rawUnitLines('`${n} mm`')).toEqual([]);
    expect(rawUnitLines('`${a} m²`')).toEqual([]);
    expect(rawUnitLines("const unit: 'km' | 'mi' = 'km';")).toEqual([]);
    expect(rawUnitLines('// e.g. `${d} km`')).toEqual([]);
    expect(rawUnitLines(' * "1.23 km" / "840 m"')).toEqual([]);
    expect(rawUnitLines('`${value} ${unit}`')).toEqual([]);
    expect(rawUnitLines('{formatElevation(first)} → {formatElevation(last)}')).toEqual([]);
  });

  it('finds no hand-formatted distance, height or speed outside the formatter', () => {
    const offenders: string[] = [];
    let scanned = 0;
    let allowedHits = 0;
    for (const dir of SCAN) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split('\\').join('/');
        scanned++;
        if (Object.keys(ALLOWED).some((prefix) => rel.startsWith(prefix))) {
          allowedHits += rawUnitLines(readFileSync(file, 'utf8')).length;
          continue;
        }
        for (const line of rawUnitLines(readFileSync(file, 'utf8'))) {
          offenders.push(`${rel}: ${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The scan really ran, and really sees the shapes (the allowed files have them).
    expect(scanned).toBeGreaterThan(500);
    expect(allowedHits).toBeGreaterThan(10);
  });

  it('lists only paths that exist', () => {
    for (const prefix of Object.keys(ALLOWED)) {
      expect(() => statSync(join(ROOT, prefix))).not.toThrow();
    }
  });
});
