import { useMemo } from 'react';

import { weatherLayerById, type WeatherLayerId } from '@core/geo/weatherLayers';
import { interpolateRamp } from '@core/weather/colorRamp';

import { drapeOpacityFor } from './useWeather';

/** Segments across the legend ramp. */
const RAMP_SEGMENTS = 48;

/**
 * The Windy-style value scale for the active layer: the layer's own colour
 * ramp, with its `legend.labels` spaced evenly along it — both straight out of
 * the `WEATHER_LAYERS` catalog in `@core/geo/weatherLayers`, so the legend can
 * never claim a scale the drape isn't drawing.
 *
 * The drape opacity is shown because it is the number most often under review
 * (wind's 0.30 against everything else's 0.62), and reading it off the screen
 * beats going to look it up.
 */
export function Legend({ layerId }: { layerId: WeatherLayerId }) {
  const layer = weatherLayerById(layerId);
  const ramp = useMemo(() => interpolateRamp([...layer.swatch], RAMP_SEGMENTS), [layer]);

  return (
    <div className="legend panel">
      <div className="legend-head">
        <span className="legend-title">{layer.label}</span>
        <span className="legend-unit num">{layer.legend.unit}</span>
      </div>
      <div className="legend-ramp" aria-hidden="true">
        {ramp.map((c, i) => (
          <span key={i} style={{ background: c }} />
        ))}
      </div>
      <div className="legend-scale num">
        {layer.legend.labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
      <div className="legend-foot">
        <span className="micro">opacity {drapeOpacityFor(layerId).toFixed(2)}</span>
        <span className="micro wms" title={layer.wmsLayer}>
          {layer.wmsLayer}
        </span>
      </div>
    </div>
  );
}
