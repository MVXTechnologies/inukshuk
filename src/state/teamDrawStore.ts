/**
 * Team drawing's screen state (#683): drawing mode, the tool and the style
 * (remembered on this phone), teammates' live strokes, and which shape is
 * selected, has its menu open (drawing mode) or its card up (otherwise).
 *
 * Live strokes are fed by the team service's own draw channel, never by the
 * team store's refresh: only the drawing layer listens to them, so a
 * teammate drawing four times a second re-renders nothing else.
 */
import { SHAPES, type ShapeKind } from '@core/teamdraw/record';
import type { LiveStroke } from '@core/teamdraw/pen';
import type { DrawPrefs } from '@core/teamdraw/style';
import { loadTeamDraw, saveTeamDraw } from '@data/teamDrawPrefs';
import { create } from 'zustand';

/** The hint chip shows on the first few entries only. */
export const HINT_ENTRIES = 3;

interface TeamDrawState {
  hydrated: boolean;
  /** The stored style as read (normalised against my colour where used). */
  rawPrefs: unknown;
  tool: ShapeKind;
  /** Entries into drawing mode so far (for the hint chip), capped. */
  hints: number;
  active: boolean;
  /** This entry shows the hint chip. */
  hintNow: boolean;
  live: LiveStroke[];
  /** `owner:id` of the selected shape (halo, full note). */
  selected: string | null;
  /** Drawing mode: the shape whose menu (note, delete) is open. */
  menu: string | null;
  /** Outside drawing mode: the shape whose card is up. */
  card: string | null;
  /**
   * The drawing snackbar: "Julie is drawing on the map · SHOW", or (`faded`)
   * "Julie's drawings have faded". Bumped per announcement.
   */
  announced: { author: string; name: string; seq: number; faded: boolean } | null;
  hydrate: () => Promise<void>;
  enter: () => void;
  exit: () => void;
  setTool: (tool: ShapeKind) => void;
  setPrefs: (prefs: DrawPrefs) => void;
  setLive: (live: LiveStroke[]) => void;
  select: (key: string | null) => void;
  openMenu: (key: string | null) => void;
  openCard: (key: string | null) => void;
  announce: (author: string, name: string, faded?: boolean) => void;
}

let hydrating: Promise<void> | null = null;
/** A change made before the file was read: written once the read merged it. */
let dirty = false;

/**
 * Writes the whole file, so never before it was read: a write from the
 * defaults (`prefs: null`) would erase the remembered style (review 2.5.2).
 */
const persist = (s: Pick<TeamDrawState, 'hydrated' | 'rawPrefs' | 'tool' | 'hints'>) => {
  if (!s.hydrated) {
    dirty = true;
    return;
  }
  saveTeamDraw({ prefs: s.rawPrefs, tool: s.tool, hints: s.hints });
};

export const useTeamDrawStore = create<TeamDrawState>((set, get) => ({
  hydrated: false,
  rawPrefs: null,
  tool: 'free',
  hints: 0,
  active: false,
  hintNow: false,
  live: [],
  selected: null,
  menu: null,
  card: null,
  announced: null,
  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    hydrating ??= loadTeamDraw().then((v) => {
      const tool = SHAPES.includes(v.tool as ShapeKind) ? (v.tool as ShapeKind) : 'free';
      const hints =
        typeof v.hints === 'number' && Number.isFinite(v.hints)
          ? Math.min(HINT_ENTRIES, Math.max(0, Math.floor(v.hints)))
          : 0;
      // Anything chosen before the file was read wins.
      const s = get();
      set({
        hydrated: true,
        rawPrefs: s.rawPrefs ?? v.prefs ?? null,
        tool: s.tool !== 'free' ? s.tool : tool,
        hints: Math.max(s.hints, hints),
      });
      hydrating = null;
      if (dirty) {
        dirty = false;
        persist(get());
      }
    });
    return hydrating;
  },
  enter: () => {
    const s = get();
    const hints = Math.min(HINT_ENTRIES, s.hints + 1);
    set({
      active: true,
      hintNow: s.hints < HINT_ENTRIES,
      hints,
      selected: null,
      menu: null,
      card: null,
    });
    if (hints !== s.hints) persist(get());
  },
  exit: () => set({ active: false, hintNow: false, selected: null, menu: null }),
  setTool: (tool) => {
    set({ tool });
    persist(get());
  },
  setPrefs: (prefs) => {
    set({ rawPrefs: prefs });
    persist(get());
  },
  setLive: (live) => {
    if (get().live.length === 0 && live.length === 0) return;
    set({ live });
  },
  select: (selected) => set({ selected }),
  openMenu: (menu) => set({ menu, selected: menu }),
  openCard: (card) => set({ card, selected: card }),
  announce: (author, name, faded = false) =>
    set((s) => ({ announced: { author, name, faded, seq: (s.announced?.seq ?? 0) + 1 } })),
}));
