import type { Map as MlMap } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CatalogItem } from '@core/catalog/schema';
import { isWeatherLayerId, type WeatherLayerId } from '@core/geo/weatherLayers';
import type { BoundingBox, LatLng } from '@core/models';

import { CatalogPanel } from '@/catalog/CatalogPanel';
import { readUrlState } from '@/lib/urlState';
import { MapCanvas, type MapView } from '@/map/MapCanvas';
import { useMapOverlays } from '@/map/useMapOverlays';
import { TracksPanel } from '@/tracks/TracksPanel';
import { useTracks } from '@/tracks/useTracks';
import { IconClose, IconInukshuk, IconLayers, IconMoon, IconRoute, IconSun } from '@/ui/Icons';
import { THEMES, type ThemeName } from '@/ui/theme';
import { Legend } from '@/weather/Legend';
import { LayerRail } from '@/weather/LayerRail';
import { TimeScrubber } from '@/weather/TimeScrubber';
import { useWeather } from '@/weather/useWeather';

type Drawer = 'catalog' | 'tracks' | null;

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

  const tracks = useTracks();

  useEffect(() => {
    document.documentElement.dataset.theme = themeName;
    store(THEME_KEY, themeName);
  }, [themeName]);

  useEffect(() => store(LAYER_KEY, weatherLayer), [weatherLayer]);

  const onReady = useCallback((m: MlMap, epoch: number) => {
    setMap(m);
    setStyleEpoch(epoch);
  }, []);

  // Overlays must be registered BEFORE the weather hook: it fills the drape
  // sources that these layers point at, and layer order is add order.
  useMapOverlays(map, styleEpoch, theme, weatherLayer, tracks.features);
  const weather = useWeather(map, styleEpoch, weatherLayer, view);

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
        { padding: 90, duration: 900, maxZoom: 14 },
      );
    },
    [map],
  );

  const locateItem = useCallback(
    (item: CatalogItem) => {
      if (item.bbox === undefined) return;
      const [west, south, east, north] = item.bbox;
      flyToBbox({ minLng: west, minLat: south, maxLng: east, maxLat: north });
    },
    [flyToBbox],
  );

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
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.gpx$/i.test(f.name));
      if (files.length === 0) {
        setToast('That is not a .gpx file');
        return;
      }
      void tracks.importFiles(files).then((msg) => {
        setToast(msg);
        setDrawer('tracks');
      });
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
  }, [tracks]);

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

      <LayerRail value={weatherLayer} onChange={setWeatherLayer} />

      {weatherLayer !== null ? (
        <>
          <Legend layerId={weatherLayer} />
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
            <small>parsed by @core/geo/gpx, kept in this browser only</small>
          </div>
        </div>
      ) : null}

      {toast !== null ? <div className="toast panel">{toast}</div> : null}
    </div>
  );
}
