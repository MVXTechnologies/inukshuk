import type { Map as MlMap } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CatalogItem } from '@core/catalog/schema';
import type { TrackPointAt } from '@core/geo/track';
import { isWeatherLayerId, type WeatherLayerId } from '@core/geo/weatherLayers';
import { visibleTrackIds, visibleWaypoints } from '@core/library/visibility';
import type { BoundingBox, LatLng, TrackPoint, Waypoint } from '@core/models';
import { setDisplayUnits } from '@lib/format';

import { CatalogPanel } from '@/catalog/CatalogPanel';
import { LibraryPanel } from '@/library/LibraryPanel';
import type { WebTrack } from '@/library/types';
import { useLibrary } from '@/library/useLibrary';
import type { SortKey } from '@/library/sortTracks';
import { readUrlState, syncUrl } from '@/lib/urlState';
import { MapCanvas, type MapView } from '@/map/MapCanvas';
import { useLibraryLayers } from '@/map/useLibraryLayers';
import { useMapOverlays } from '@/map/useMapOverlays';
import { TracksPanel } from '@/tracks/TracksPanel';
import { useTracks } from '@/tracks/useTracks';
import { TrailFocus, type TrimPlacement, type TrimState } from '@/trail/TrailFocus';
import {
  IconClose,
  IconInukshuk,
  IconLayers,
  IconLibrary,
  IconMoon,
  IconRoute,
  IconScissors,
  IconSun,
} from '@/ui/Icons';
import { THEMES, type ThemeName } from '@/ui/theme';
import { Legend } from '@/weather/Legend';
import { LayerRail } from '@/weather/LayerRail';
import { TimeScrubber } from '@/weather/TimeScrubber';
import { useWeather } from '@/weather/useWeather';

type Drawer = 'catalog' | 'tracks' | null;

/** Stable identity for "no points loaded" — a fresh `[]` each render would
 *  re-run every memo in the profile on every keystroke elsewhere. */
const EMPTY_POINTS: TrackPoint[] = [];

const THEME_KEY = 'inukshuk-playground:theme';
const LAYER_KEY = 'inukshuk-playground:layer';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: preferences just don't persist.
  }
}

/** Query-string overrides win over stored preferences, so a shared capture
 *  URL always opens on the state it names. Read once, at mount. */
const URL_STATE = readUrlState(window.location.search);

// `@lib/format` keeps the unit system in a module-level variable (the app's
// settings store calls this on hydrate). Set it before the first render so no
// card ever paints in the wrong units and then swaps.
setDisplayUnits(URL_STATE.units ?? 'metric');

export function App() {
  const [themeName, setThemeName] = useState<ThemeName>(
    () => URL_STATE.theme ?? (readStored(THEME_KEY) === 'light' ? 'light' : 'dark'),
  );
  // `?basemap=` swaps only the cartography, leaving every theme token (and the
  // weather dim) alone — which is what makes it useful for comparing OFM
  // styles under an otherwise identical treatment.
  //
  // Memoised because `theme` is an identity dependency of the overlay stack:
  // a fresh object every render would tear the whole layer stack down and
  // rebuild it on every render.
  const theme = useMemo(
    () =>
      URL_STATE.basemap === null
        ? THEMES[themeName]
        : {
            ...THEMES[themeName],
            basemapStyle: URL_STATE.basemap,
            mutedBasemapStyle: URL_STATE.basemap,
          },
    [themeName],
  );

  const [weatherLayer, setWeatherLayer] = useState<WeatherLayerId | null>(() => {
    if (URL_STATE.layer !== 'unset') return URL_STATE.layer;
    const stored = readStored(LAYER_KEY);
    return stored !== null && isWeatherLayerId(stored) ? stored : 'wind';
  });
  const [drawer, setDrawer] = useState<Drawer>(URL_STATE.panel);
  const [map, setMap] = useState<MlMap | null>(null);
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [view, setView] = useState<MapView | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ----------------------------------------------------------- library ----
  const lib = useLibrary();
  const [surface, setSurface] = useState<'map' | 'library' | 'trail'>(URL_STATE.view);
  const [trailId, setTrailId] = useState<string | null>(URL_STATE.trail);
  // Keyed by trail id, so leaving the screen needs no clearing setState in an
  // effect: the points are simply not the ones being asked for any more.
  const [loaded, setLoaded] = useState<{ id: string; points: TrackPoint[] } | null>(null);
  const [trim, setTrim] = useState<TrimState | null>(null);
  const [scrub, setScrub] = useState<TrackPointAt | null>(null);
  const [sort, setSort] = useState<SortKey>(URL_STATE.sort ?? 'recent');
  const [trimAt, setTrimAt] = useState<TrimPlacement>(URL_STATE.trimAt ?? 'rail');
  const [panelWidth, setPanelWidth] = useState<'phone' | 'wide'>(URL_STATE.width ?? 'phone');
  const [filter, setFilter] = useState({});

  const tracks = useTracks();

  useEffect(() => {
    document.documentElement.dataset.theme = themeName;
    store(THEME_KEY, themeName);
  }, [themeName]);

  useEffect(() => store(LAYER_KEY, weatherLayer), [weatherLayer]);

  // The address bar mirrors the view, so any screenshot can be handed back as
  // a link that reopens exactly this state.
  useEffect(() => {
    syncUrl({
      theme: themeName,
      view: surface === 'map' ? null : surface,
      trail: surface === 'trail' ? trailId : null,
      sort: sort === 'recent' ? null : sort,
      trimAt: surface === 'trail' ? trimAt : null,
      w: panelWidth === 'phone' ? null : panelWidth,
    });
  }, [themeName, surface, trailId, sort, trimAt, panelWidth]);

  const onReady = useCallback((m: MlMap, epoch: number) => {
    setMap(m);
    setStyleEpoch(epoch);
  }, []);

  // What the map is allowed to draw, decided by `@core/library/visibility` —
  // the same selectors the app's map uses, fed the same mode + folder ids.
  const shownTracks = useMemo(() => {
    const ids = new Set(
      visibleTrackIds(
        lib.index.mapVisibilityMode,
        lib.index.visibleFolderIds,
        lib.index.tracks,
        lib.index.tracks.map((t) => t.id),
      ),
    );
    return lib.index.tracks.filter((t) => ids.has(t.id));
  }, [lib.index]);

  const shownWaypoints = useMemo(
    () =>
      visibleWaypoints(
        lib.index.mapVisibilityMode,
        lib.index.visibleFolderIds,
        lib.index.waypoints,
      ),
    [lib.index],
  );

  // Overlays must be registered BEFORE the weather hook: it fills the drape
  // sources that these layers point at, and layer order is add order.
  useMapOverlays(map, styleEpoch, theme, weatherLayer, tracks.features);
  const weather = useWeather(map, styleEpoch, weatherLayer, view);
  // Registered last: the Library's own trails sit above everything else.
  useLibraryLayers(
    map,
    styleEpoch,
    theme,
    surface === 'map' ? [] : shownTracks,
    surface === 'map' ? [] : shownWaypoints,
    surface === 'trail' ? trailId : null,
    scrub,
  );

  const origin: LatLng | null =
    view === null
      ? null
      : { latitude: (view.south + view.north) / 2, longitude: (view.west + view.east) / 2 };

  // ------------------------------------------------------------- actions --
  const flyToBbox = useCallback(
    (b: BoundingBox) => {
      map?.fitBounds(
        [
          [b.minLng, b.minLat],
          [b.maxLng, b.maxLat],
        ],
        {
          padding: { top: 90, bottom: 90, right: 90, left: panelWidth === 'wide' ? 760 : 430 },
          duration: 900,
          maxZoom: 14,
        },
      );
    },
    [map, panelWidth],
  );

  const locateItem = useCallback(
    (item: CatalogItem) => {
      if (item.bbox === undefined) return;
      const [west, south, east, north] = item.bbox;
      flyToBbox({ minLng: west, minLat: south, maxLng: east, maxLat: north });
    },
    [flyToBbox],
  );

  const openTrail = useCallback((id: string) => {
    // The Library's ⋮ → Trim passes `<id>!trim`, the same one-shot intent the
    // app expresses as `/trail3d/<id>?trim=1`.
    const wantsTrim = id.endsWith('!trim');
    const clean = wantsTrim ? id.slice(0, -5) : id;
    setTrailId(clean);
    setSurface('trail');
    setTrim(wantsTrim ? { start: 0, end: 0 } : null);
  }, []);

  const backToLibrary = useCallback(() => {
    setSurface('library');
    setTrailId(null);
    setTrim(null);
    setScrub(null);
  }, []);

  // Load the focused trail's real points, and frame it.
  useEffect(() => {
    if (surface !== 'trail' || trailId === null) return;
    let live = true;
    void lib.loadPoints(trailId).then((points) => {
      if (!live) return;
      setLoaded({ id: trailId, points });
      // A trim intent arrives before the points do; open the full range once
      // the length is known.
      setTrim((t) => (t !== null && t.end === 0 ? { start: 0, end: points.length - 1 } : t));
    });
    const bbox = lib.index.tracks.find((t) => t.id === trailId)?.stats.bbox;
    if (bbox !== undefined) flyToBbox(bbox);
    return () => {
      live = false;
    };
  }, [surface, trailId, lib, flyToBbox]);

  const trailPoints = loaded !== null && loaded.id === trailId ? loaded.points : EMPTY_POINTS;

  // ---------------------------------------------------------- drag & drop --
  const dragDepth = useRef(0);
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth.current += 1;
      setDragging(true);
    };
    const leave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = [...e.dataTransfer.files].filter((f) => /\.gpx$/i.test(f.name));
      if (files.length === 0) {
        setToast('That is not a .gpx file');
        return;
      }
      // A dropped GPX joins the LIBRARY when the Library is what you are
      // looking at, and the weather map's own track list otherwise — dropping
      // a file always adds it to the surface in front of you.
      if (surface === 'map') {
        void tracks.importFiles(files).then((msg) => {
          setToast(msg);
          setDrawer('tracks');
        });
      } else {
        void lib.importFiles(files).then(setToast);
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [tracks, lib, surface]);

  // Zoom to a freshly imported track once it is on the map.
  const lastCount = useRef(0);
  useEffect(() => {
    if (!tracks.ready) return;
    if (tracks.tracks.length > lastCount.current) {
      const newest = tracks.tracks[tracks.tracks.length - 1];
      if (newest?.stats.bbox !== undefined) flyToBbox(newest.stats.bbox);
    }
    lastCount.current = tracks.tracks.length;
  }, [tracks.tracks, tracks.ready, flyToBbox]);

  useEffect(() => {
    if (toast === null) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const locateTrack = useCallback(
    (track: WebTrack) => {
      if (track.stats.bbox !== undefined) flyToBbox(track.stats.bbox);
    },
    [flyToBbox],
  );

  const locateWaypoint = useCallback(
    (w: Waypoint) => {
      map?.easeTo({ center: [w.longitude, w.latitude], zoom: 13.6, duration: 800 });
    },
    [map],
  );

  const libraryOpen = surface !== 'map';

  // ------------------------------------------------------------- render ---
  return (
    <div className="shell">
      <MapCanvas
        theme={theme}
        muted={weatherLayer !== null}
        initialCenter={URL_STATE.center}
        initialZoom={URL_STATE.zoom}
        onReady={onReady}
        onView={setView}
      />

      <div className="topbar">
        <div className="brand panel">
          <IconInukshuk className="brand-mark" />
          <span className="brand-name">Inukshuk</span>
          <span className="brand-tag">Playground</span>
        </div>

        <div className="seg panel">
          <button
            type="button"
            aria-pressed={surface === 'map'}
            onClick={() => {
              setSurface('map');
              setTrailId(null);
              setScrub(null);
            }}
          >
            <IconLayers size={15} />
            Map
          </button>
          <button
            type="button"
            aria-pressed={libraryOpen}
            onClick={() => setSurface(libraryOpen ? 'map' : 'library')}
          >
            <IconLibrary size={15} />
            Library
            {lib.index.tracks.length > 0 ? (
              <span className="chip-count num">{lib.index.tracks.length}</span>
            ) : null}
          </button>
        </div>

        <span className="spacer" />

        <div className="seg panel">
          <button
            type="button"
            aria-pressed={drawer === 'catalog'}
            onClick={() => setDrawer((d) => (d === 'catalog' ? null : 'catalog'))}
          >
            <IconLayers size={15} />
            Catalog
          </button>
          <button
            type="button"
            aria-pressed={drawer === 'tracks'}
            onClick={() => setDrawer((d) => (d === 'tracks' ? null : 'tracks'))}
          >
            <IconRoute size={15} />
            Tracks
            {tracks.tracks.length > 0 ? (
              <span className="chip-count num">{tracks.tracks.length}</span>
            ) : null}
          </button>
        </div>

        <button
          type="button"
          className="icon-btn panel"
          onClick={() => setThemeName((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={`Switch to ${themeName === 'dark' ? 'light' : 'dark'} theme`}
          aria-label="Toggle theme"
        >
          {themeName === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
        </button>
      </div>

      {/* The layer rail and the legend share the left edge with the Library,
          so they stand down while it is up rather than fighting it. */}
      {libraryOpen ? null : <LayerRail value={weatherLayer} onChange={setWeatherLayer} />}

      {weatherLayer !== null ? (
        <>
          {libraryOpen ? null : <Legend layerId={weatherLayer} />}
          <TimeScrubber
            timeline={weather.timeline}
            frameIndex={weather.frameIndex}
            onFrame={weather.setFrameIndex}
            playing={weather.playing}
            onTogglePlay={weather.togglePlay}
            referenceTimeMs={weather.referenceTimeMs}
            loading={weather.loading}
          />
        </>
      ) : null}

      {libraryOpen ? (
        <div className={`library panel${panelWidth === 'wide' ? ' wide' : ''}`}>
          <div className="drawer-head">
            <span className="drawer-title">
              {surface === 'trail' ? 'Trail' : 'Library'}
              <span className="head-count micro">
                {lib.index.tracks.length} trails · {lib.index.waypoints.length} waypoints
              </span>
            </span>
            <div className="seg inline">
              <button
                type="button"
                aria-pressed={panelWidth === 'phone'}
                title="Phone-width column (390 px)"
                onClick={() => setPanelWidth('phone')}
              >
                Phone
              </button>
              <button
                type="button"
                aria-pressed={panelWidth === 'wide'}
                title="Desktop-width column (720 px)"
                onClick={() => setPanelWidth('wide')}
              >
                Wide
              </button>
            </div>
            <button
              type="button"
              className="row-action"
              onClick={() => {
                setSurface('map');
                setTrailId(null);
                setScrub(null);
              }}
              aria-label="Close"
            >
              <IconClose size={14} />
            </button>
          </div>

          <div className="drawer-body">
            {lib.seeding !== null ? (
              <div className="note">
                Generating the Québec demo library — {Math.round(lib.seeding * 100)}%.
                <br />
                Twenty-three real routes, synthesised into full 1 Hz recordings and round-tripped
                through <code>@core/geo/gpx</code>.
              </div>
            ) : null}

            {surface === 'trail' && trailId !== null ? (
              <TrailFocus
                lib={lib}
                trackId={trailId}
                points={trailPoints}
                placement={trimAt}
                onPlacement={setTrimAt}
                trim={trim}
                onTrim={setTrim}
                onBack={backToLibrary}
                onLocate={() => {
                  const t = lib.index.tracks.find((x) => x.id === trailId);
                  if (t !== undefined) locateTrack(t);
                }}
                onScrub={setScrub}
                onToast={setToast}
              />
            ) : (
              <LibraryPanel
                lib={lib}
                filter={filter}
                onFilter={setFilter}
                sort={sort}
                onSort={setSort}
                onOpenTrail={openTrail}
                onLocateTrack={locateTrack}
                onLocateWaypoint={locateWaypoint}
              />
            )}
          </div>
        </div>
      ) : null}

      {/* Placement candidate "rail": today's app puts the scissors on a
          floating rail over the map, away from the trail it edits. */}
      {surface === 'trail' && trimAt === 'rail' && trim === null && trailPoints.length >= 3 ? (
        <button
          type="button"
          className="fab panel"
          aria-label="Trim trail"
          title="Trim trail"
          onClick={() => setTrim({ start: 0, end: trailPoints.length - 1 })}
        >
          <IconScissors size={17} />
        </button>
      ) : null}

      {drawer !== null ? (
        <div className="drawer panel">
          <div className="drawer-head">
            <span className="drawer-title">
              {drawer === 'catalog' ? 'Map catalog' : 'GPX tracks'}
            </span>
            <button
              type="button"
              className="row-action"
              onClick={() => setDrawer(null)}
              aria-label="Close"
            >
              <IconClose size={14} />
            </button>
          </div>
          <div className="drawer-body">
            {drawer === 'catalog' ? (
              <CatalogPanel origin={origin} onLocate={locateItem} />
            ) : (
              <TracksPanel
                tracks={tracks.tracks}
                onLocate={flyToBbox}
                onRemove={tracks.remove}
                onClear={tracks.clear}
              />
            )}
          </div>
        </div>
      ) : null}

      {dragging ? (
        <div className="dropzone">
          <div className="dropzone-inner">
            Drop a GPX file
            <small>
              {surface === 'map'
                ? 'parsed by @core/geo/gpx, kept in this browser only'
                : 'imported into the Library, kept in this browser only'}
            </small>
          </div>
        </div>
      ) : null}

      {toast !== null ? <div className="toast panel">{toast}</div> : null}
    </div>
  );
}
