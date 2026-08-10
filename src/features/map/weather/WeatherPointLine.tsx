import type { WeatherLayerId } from '@core/geo/weatherLayers';
import type { LatLng } from '@core/models';
import { pointReadoutText } from '@core/weather/pointReadout';
import type { WeatherModelId } from '@core/weather/weatherModels';
import { useSettingsStore } from '@state/settingsStore';
import { MapPointLine } from '../components/MapPointChip';
import { useWeatherPointValue } from './useWeatherPointValue';

/**
 * The weather line of the tap-anywhere chip (wave A item 7, the Windy picker
 * idiom): with a weather layer draped, a single tap on bare map shows the
 * gridded GetFeatureInfo value for the active layer/model at the SCRUBBED
 * time — "14° · HRDPS · Sun 14:00". Scrubbing while the chip is up refetches
 * it for the new frame.
 *
 * Marine wave D turned the chip itself into the shared `MapPointChip`
 * surface (weather / depth / coordinates all stack in one chip), so this is
 * now just the line and its data hook — the chrome, the pointer tail and the
 * anchor dot live in the chip.
 */
export function WeatherPointLine({
  at,
  layer,
  model,
  timeIso,
  selectedMs,
}: {
  at: LatLng;
  layer: WeatherLayerId;
  model: WeatherModelId;
  /** The drape's committed (throttled) WMS TIME — what the value is pinned to. */
  timeIso: string | undefined;
  /** Scrubbed frame epoch-ms, for the readout's time segment. */
  selectedMs: number | null;
}) {
  const { status, value } = useWeatherPointValue(at, layer, model, timeIso);
  const units = useSettingsStore((s) => s.units);

  // Prefer the server's own valid time for the readout (truth over intent);
  // fall back to the scrubbed frame while loading / when absent.
  const serverMs = value?.time != null ? Date.parse(value.time) : NaN;
  const timeMs = Number.isFinite(serverMs) ? serverMs : selectedMs;

  const text =
    status === 'ready' && value !== null
      ? pointReadoutText(layer, model, value.value, units === 'imperial', timeMs)
      : status === 'loading'
        ? '…'
        : 'No data';

  return <MapPointLine text={text} />;
}
