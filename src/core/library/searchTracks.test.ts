import type { Folder, TrackStats, TrackSummary } from '@core/models';
import { filterTracks } from './filterTracks';
import {
  foldForSearch,
  isSearchActive,
  matchesTerms,
  searchTerms,
  searchTracks,
} from './searchTracks';
import { sortTracks } from './sortTracks';

const stats = (over: Partial<TrackStats> = {}): TrackStats => ({
  distanceM: 1000,
  ascentM: 100,
  descentM: 100,
  durationS: 600,
  movingTimeS: 600,
  avgSpeedMps: 1000 / 600,
  maxSpeedMps: 3,
  pointCount: 10,
  ...over,
});

const track = (over: Partial<TrackSummary> & { id: string; name: string }): TrackSummary => ({
  startedAt: 1_700_000_000_000,
  stats: stats(),
  fileUri: `file:///${over.id}.gpx`,
  ...over,
});

const folder = (id: string, name: string): Folder => ({ id, name, createdAt: 0 });

describe('foldForSearch', () => {
  it('strips accents via NFD decomposition', () => {
    expect(foldForSearch('Éperon')).toBe('eperon');
    expect(foldForSearch('Forêt Montmorency')).toBe('foret montmorency');
    expect(foldForSearch('Îlot à Bœufs')).toBe('ilot a bœufs');
  });

  it('folds every separator shape to a single space', () => {
    expect(foldForSearch('Sainte-Anne')).toBe('sainte anne');
    expect(foldForSearch('Sainte–Anne')).toBe('sainte anne');
    expect(foldForSearch("L'Île")).toBe('l ile');
    expect(foldForSearch('L’Île')).toBe('l ile');
    expect(foldForSearch('  Mont   /  Ste-Anne  ')).toBe('mont ste anne');
  });

  it('lowercases and trims', () => {
    expect(foldForSearch('  CAP TOURMENTE ')).toBe('cap tourmente');
  });

  it('folds a precomposed and a decomposed spelling to the same string', () => {
    // The same word typed with a combining acute vs. a single code point.
    expect(foldForSearch('\u00c9peron')).toBe(foldForSearch('E\u0301peron'));
  });

  it('yields the empty string for a query with nothing searchable in it', () => {
    expect(foldForSearch('')).toBe('');
    expect(foldForSearch('   ')).toBe('');
    expect(foldForSearch('--- ... ')).toBe('');
  });
});

describe('searchTerms / isSearchActive', () => {
  it('splits a folded query into terms', () => {
    expect(searchTerms('Sainte-Anne du Nord')).toEqual(['sainte', 'anne', 'du', 'nord']);
  });

  it('treats blank and punctuation-only queries as inactive', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
    expect(isSearchActive('')).toBe(false);
    expect(isSearchActive('  -- ')).toBe(false);
    expect(isSearchActive('a')).toBe(true);
  });
});

describe('searchTracks', () => {
  const tracks: TrackSummary[] = [
    track({ id: 'a', name: 'Sentier de l’Éperon', folderId: 'f1' }),
    track({ id: 'b', name: 'Mont Sainte-Anne', folderId: 'f2' }),
    track({ id: 'c', name: 'Cap Tourmente' }),
    track({
      id: 'd',
      name: 'Sentier 10',
      notes: [
        { id: 'n1', distanceM: 100, text: 'Pont de bois glacé', createdAt: 1 },
        { id: 'n2', distanceM: 200, text: '', createdAt: 2 },
      ],
    }),
  ];
  const folders = [folder('f1', 'Parc de la Jacques-Cartier'), folder('f2', 'Côte-de-Beaupré')];
  const ids = (result: readonly TrackSummary[]) => result.map((t) => t.id);

  it('returns the input array as-is for an empty query (stable identity)', () => {
    expect(searchTracks(tracks, '', folders)).toBe(tracks);
    expect(searchTracks(tracks, '   ', folders)).toBe(tracks);
  });

  it('matches case-insensitively', () => {
    expect(ids(searchTracks(tracks, 'CAP', folders))).toEqual(['c']);
    expect(ids(searchTracks(tracks, 'cap tourmente', folders))).toEqual(['c']);
  });

  it('matches accent-insensitively in both directions', () => {
    expect(ids(searchTracks(tracks, 'eperon', folders))).toEqual(['a']);
    expect(ids(searchTracks(tracks, 'Éperon', folders))).toEqual(['a']);
  });

  it('matches across separators: "sainte anne" finds "Sainte-Anne"', () => {
    expect(ids(searchTracks(tracks, 'sainte anne', folders))).toEqual(['b']);
    expect(ids(searchTracks(tracks, 'sainte-anne', folders))).toEqual(['b']);
    expect(ids(searchTracks(tracks, 'Sainte’Anne', folders))).toEqual(['b']);
  });

  it('ANDs the terms, so word order does not matter', () => {
    expect(ids(searchTracks(tracks, 'anne sainte', folders))).toEqual(['b']);
    expect(ids(searchTracks(tracks, 'sainte tourmente', folders))).toEqual([]);
  });

  it('matches a partial word', () => {
    expect(ids(searchTracks(tracks, 'epe', folders))).toEqual(['a']);
  });

  it('narrows to a folder when the query is the folder name', () => {
    expect(ids(searchTracks(tracks, 'jacques cartier', folders))).toEqual(['a']);
    // Accent-folded folder name too.
    expect(ids(searchTracks(tracks, 'cote de beaupre', folders))).toEqual(['b']);
  });

  it('matches note text', () => {
    expect(ids(searchTracks(tracks, 'pont de bois', folders))).toEqual(['d']);
    expect(ids(searchTracks(tracks, 'glace', folders))).toEqual(['d']);
  });

  it('ignores folder names when no folders are supplied', () => {
    expect(ids(searchTracks(tracks, 'jacques'))).toEqual([]);
    expect(ids(searchTracks(tracks, 'eperon'))).toEqual(['a']);
  });

  it('ignores a folderId pointing at a folder that no longer exists', () => {
    const orphan = [track({ id: 'z', name: 'Orpheline', folderId: 'gone' })];
    expect(ids(searchTracks(orphan, 'orpheline', folders))).toEqual(['z']);
    expect(ids(searchTracks(orphan, 'gone', folders))).toEqual([]);
  });

  it('preserves the incoming order and never mutates the input', () => {
    const before = [...tracks];
    const result = searchTracks(tracks, 'sentier', folders);
    expect(ids(result)).toEqual(['a', 'd']);
    expect(tracks).toEqual(before);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchTracks(tracks, 'zzz', folders)).toEqual([]);
  });

  it('survives a hand-edited library: no name, no notes array', () => {
    const rough = [
      { ...track({ id: 'x', name: 'ok' }), name: undefined } as unknown as TrackSummary,
      { ...track({ id: 'y', name: 'Bois-de-Coulonge' }), notes: undefined },
    ];
    expect(() => searchTracks(rough, 'bois', folders)).not.toThrow();
    expect(ids(searchTracks(rough, 'bois', folders))).toEqual(['y']);
  });
});

describe('matchesTerms', () => {
  const none = new Map<string, string>();

  it('matches everything when there are no terms', () => {
    expect(matchesTerms(track({ id: 'a', name: 'anything' }), [], none)).toBe(true);
  });

  it('requires every term', () => {
    const t = track({ id: 'a', name: 'Mont Sainte-Anne' });
    expect(matchesTerms(t, ['mont', 'anne'], none)).toBe(true);
    expect(matchesTerms(t, ['mont', 'nord'], none)).toBe(false);
  });
});

describe('composition with the sibling passes', () => {
  interface RichTrack extends TrackSummary {
    color: string;
  }
  const rich: RichTrack[] = [
    {
      ...track({ id: 'a', name: 'Sentier des Caps', stats: stats({ distanceM: 5000 }) }),
      color: '#f00',
    },
    {
      ...track({ id: 'b', name: 'Sentier du Cap Rouge', stats: stats({ distanceM: 9000 }) }),
      color: '#0f0',
    },
    {
      ...track({ id: 'c', name: 'Chute Montmorency', stats: stats({ distanceM: 2000 }) }),
      color: '#00f',
    },
  ];

  it('keeps the caller element type through search -> filter -> sort', () => {
    const out = sortTracks(filterTracks(searchTracks(rich, 'sentier'), {}), 'distance');
    // The `color` access is the point: a widened TrackSummary would not compile.
    expect(out.map((t) => `${t.id}${t.color}`)).toEqual(['b#0f0', 'a#f00']);
  });

  it('search narrows before the filter sees the list', () => {
    const out = filterTracks(searchTracks(rich, 'cap'), { distanceM: { min: 6000 } });
    expect(out.map((t) => t.id)).toEqual(['b']);
  });
});
