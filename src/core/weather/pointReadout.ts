import { weatherLayerById, type WeatherLayerId } from '@core/geo/weatherLayers';
import { formatTimelineLabel } from '@core/geo/weatherTimeline';
import {
  compareCellText,
  compareUnitLabel,
  modelVariableForLayer,
  weatherModelById,
  type WeatherModelId,
} from './weatherModels';

/**
 * The tap-anywhere point-value chip's text (weather wave A, field item 7):
 * a compact Windy-style readout — "14° · HRDPS · Sun 14:00" — for the
 * GetFeatureInfo value under a tapped point at the scrubbed time.
 *
 * Value formatting reuses the comparison table's rules (`compareCellText`):
 * whole degrees, whole km/h (or mph), millimetres with one decimal. Radar
 * layers are model-less, so their readout drops the model segment and shows
 * the layer's legend unit instead ("2.4 mm/h · Sun 14:00").
 */
export function pointReadoutText(
  layerId: WeatherLayerId,
  modelId: WeatherModelId,
  value: number,
  imperial: boolean,
  timeMs: number | null,
): string {
  const variable = modelVariableForLayer(layerId);
  let valuePart: string;
  let modelPart: string | null;
  if (variable === null) {
    // Radar: raw gridded value in the layer's legend unit, one decimal.
    valuePart = `${Math.round(value * 10) / 10} ${weatherLayerById(layerId).legend.unit}`;
    modelPart = null;
  } else {
    const cell = compareCellText(variable, value, imperial);
    // Temperature's cell text already ends in the degree sign; the other
    // variables append their unit label ("23 km/h", "1.2 mm").
    valuePart = variable === 'temp' ? cell : `${cell} ${compareUnitLabel(variable, imperial)}`;
    modelPart = weatherModelById(modelId).label;
  }
  const timePart = timeMs !== null ? formatTimelineLabel(timeMs) : null;
  return [valuePart, modelPart, timePart].filter((p) => p !== null).join(' · ');
}
