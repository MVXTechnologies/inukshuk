import {
  capabilitiesUrlForLayer,
  weatherLayerById,
  type WeatherLayerId,
} from '@core/geo/weatherLayers';

/**
 * ECCC forecast-model catalog (weather UX M2): the three deterministic GeoMet
 * model families a forecast drape can resolve against — HRDPS (2.5 km / 48 h),
 * RDPS (10 km / 84 h) and GDPS (15 km / 240 h, hourly to +84 h then
 * 3-hourly). Radar layers stay model-less. Every WMS layer name below was
 * verified live against the GeoMet capabilities on 2026-08-09 — note the
 * naming-scheme split: HRDPS kept the legacy `HRDPS.CONTINENTAL_*` ids while
 * RDPS/GDPS moved to `RDPS_10km_*` / `GDPS_15km_*` (the old `RDPS.ETA_*`
 * family 404s with InvalidLayersParameter).
 *
 * `drape` names the GetMap layer per forecast variable (TT temperature
 * ramp, PR total accumulation; wind uses the scalar SPEED layer since M3 —
 * a smooth Windy-style gradient under the particle overlay, never the
 * arrow/barb `_UU`/`Winds` composites). `info` names the GetFeatureInfo layer the
 * comparison table queries — wind uses the scalar speed layer [m/s] and
 * precip the 1-hour interval accumulation [mm], which are comparable across
 * models (total accumulation is not: horizons differ).
 */

/** Forecast variables that resolve per-model (radar never lands here). */
export type ModelVariable = 'temp' | 'wind' | 'precip';

export const WEATHER_MODELS = [
  // Labels double as a11y/Maestro match targets; keep them regex-safe.
  // NOTE: 'HRDPS' contains 'RDPS' as a substring — UI rows must prefix their
  // accessibility labels (e.g. "Model RDPS") so wrapped regex matchers can't
  // cross-match.
  {
    id: 'hrdps',
    label: 'HRDPS',
    resolution: '2.5 km',
    horizonHours: 48,
    horizonLabel: '48 h',
    /** Hour offset from the run where the step cadence changes, if any. */
    cadenceChangeHours: null,
    stepHoursAfterChange: null,
    drape: {
      temp: 'HRDPS.CONTINENTAL_TT',
      wind: 'HRDPS.CONTINENTAL_WSPD',
      precip: 'HRDPS.CONTINENTAL_PR',
    },
    info: {
      temp: 'HRDPS.CONTINENTAL_TT',
      wind: 'HRDPS.CONTINENTAL_WSPD',
      precip: 'HRDPS.CONTINENTAL.DIAG_PR_PT1H',
    },
  },
  {
    id: 'rdps',
    label: 'RDPS',
    resolution: '10 km',
    horizonHours: 84,
    horizonLabel: '84 h',
    cadenceChangeHours: null,
    stepHoursAfterChange: null,
    drape: {
      temp: 'RDPS_10km_AirTemp_2m',
      wind: 'RDPS_10km_WindSpeed_10m',
      precip: 'RDPS_10km_Precip-Accum',
    },
    info: {
      temp: 'RDPS_10km_AirTemp_2m',
      wind: 'RDPS_10km_WindSpeed_10m',
      precip: 'RDPS_10km_Precip-Accum1h',
    },
  },
  {
    id: 'gdps',
    label: 'GDPS',
    resolution: '15 km',
    horizonHours: 240,
    horizonLabel: '10 d',
    cadenceChangeHours: 84,
    stepHoursAfterChange: 3,
    drape: {
      temp: 'GDPS_15km_AirTemp_2m',
      wind: 'GDPS_15km_WindSpeed_10m',
      precip: 'GDPS_15km_Precip-Accum',
    },
    info: {
      temp: 'GDPS_15km_AirTemp_2m',
      wind: 'GDPS_15km_WindSpeed_10m',
      precip: 'GDPS_15km_Precip-Accum1h',
    },
  },
] as const;

export type WeatherModelId = (typeof WEATHER_MODELS)[number]['id'];
export type WeatherModel = (typeof WEATHER_MODELS)[number];

export const WEATHER_MODEL_IDS: readonly WeatherModelId[] = WEATHER_MODELS.map((m) => m.id);

/** The launch default — highest resolution, the M1 behaviour verbatim. */
export const DEFAULT_WEATHER_MODEL: WeatherModelId = 'hrdps';

export function isWeatherModelId(v: unknown): v is WeatherModelId {
  return typeof v === 'string' && (WEATHER_MODEL_IDS as readonly string[]).includes(v);
}

/**
 * Settings-hydration sanitizer: junk collapses to the HRDPS default (unlike
 * `sanitizeWeatherLayer` there is no "off" state — a model is always chosen).
 */
export function sanitizeWeatherModel(v: unknown): WeatherModelId {
  return isWeatherModelId(v) ? v : DEFAULT_WEATHER_MODEL;
}

export function weatherModelById(id: WeatherModelId): WeatherModel {
  return WEATHER_MODELS.find((m) => m.id === id) ?? WEATHER_MODELS[0];
}

/**
 * Which forecast variable a catalog layer maps to, or null for the
 * model-less layers (radar): those never resolve per-model.
 */
export function modelVariableForLayer(id: WeatherLayerId): ModelVariable | null {
  switch (id) {
    case 'temp':
      return 'temp';
    case 'wind':
      return 'wind';
    case 'precip':
      return 'precip';
    default:
      return null;
  }
}

/**
 * The GetMap WMS layer name a catalog layer resolves to under a model:
 * forecast layers swap to the model's drape id; radar layers keep their
 * model-less catalog id no matter the model.
 */
export function resolveModelWmsLayer(layerId: WeatherLayerId, modelId: WeatherModelId): string {
  const variable = modelVariableForLayer(layerId);
  if (variable === null) return weatherLayerById(layerId).wmsLayer;
  return weatherModelById(modelId).drape[variable];
}

/** Per-model layer-scoped GetCapabilities URL (the scrubber's TIME window). */
export function modelCapabilitiesUrl(layerId: WeatherLayerId, modelId: WeatherModelId): string {
  return capabilitiesUrlForLayer(resolveModelWmsLayer(layerId, modelId));
}

/** Picker-row caption, e.g. "2.5 km · 48 h" (the Windy subscript idiom). */
export function modelCaption(model: WeatherModel): string {
  return `${model.resolution} · ${model.horizonLabel}`;
}

/**
 * Comparison-table cell text for a raw GetFeatureInfo value. GeoMet units
 * (verified in the layer titles): temp °C, wind speed m/s, 1 h precip mm.
 * Display follows Windy's compact table: whole degrees, whole km/h (or mph),
 * millimetres with one decimal (precip stays metric in both unit systems —
 * same as the drape legend).
 */
export function compareCellText(variable: ModelVariable, value: number, imperial: boolean): string {
  switch (variable) {
    case 'temp':
      return `${Math.round(imperial ? (value * 9) / 5 + 32 : value)}°`;
    case 'wind':
      return `${Math.round(imperial ? value * 2.23694 : value * 3.6)}`;
    case 'precip':
      return value < 0.05 ? '0' : `${Math.round(value * 10) / 10}`;
  }
}

/** Row-rail unit label matching {@link compareCellText}. */
export function compareUnitLabel(variable: ModelVariable, imperial: boolean): string {
  switch (variable) {
    case 'temp':
      return imperial ? '°F' : '°C';
    case 'wind':
      return imperial ? 'mph' : 'km/h';
    case 'precip':
      return 'mm';
  }
}
