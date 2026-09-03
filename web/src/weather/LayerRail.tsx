import { useMemo } from 'react';

import { WEATHER_LAYERS, type WeatherLayerId } from '@core/geo/weatherLayers';
import { interpolateRamp } from '@core/weather/colorRamp';

import { IconSlash } from '@/ui/Icons';

/** Segments per thumbnail. Enough that the seams disappear at 26 px. */
const THUMB_SEGMENTS = 24;

/**
 * The layer picker.
 *
 * The circular colour thumbnails are the app's own idea and the app's own
 * maths: each layer's `swatch` stops are expanded by
 * `@core/weather/colorRamp#interpolateRamp` into adjacent segments, which reads
 * as a continuous ramp with no gradient asset. On the phone that keeps the
 * picker OTA-clean (no binary); here it just means the playground and the app
 * cannot drift on what a layer's colour identity is.
 */
export function LayerRail({
  value,
  onChange,
}: {
  value: WeatherLayerId | null;
  onChange: (id: WeatherLayerId | null) => void;
}) {
  const ramps = useMemo(
    () =>
      new Map(
        WEATHER_LAYERS.map((l) => [l.id, interpolateRamp([...l.swatch], THUMB_SEGMENTS)] as const),
      ),
    [],
  );

  return (
    <div className="rail panel" role="group" aria-label="Weather layer">
      {WEATHER_LAYERS.map((layer) => (
        <button
          key={layer.id}
          type="button"
          className="rail-item"
          aria-pressed={value === layer.id}
          onClick={() => onChange(value === layer.id ? null : layer.id)}
          title={`${layer.label} — ${layer.wmsLayer}`}
        >
          <span className="thumb" aria-hidden="true">
            {(ramps.get(layer.id) ?? []).map((c, i) => (
              <span key={i} style={{ background: c }} />
            ))}
          </span>
          <span className="rail-label">{layer.label}</span>
        </button>
      ))}
      <button
        type="button"
        className="rail-item"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        title="No weather layer"
      >
        <span className="thumb off" aria-hidden="true">
          <IconSlash size={15} />
        </span>
        <span className="rail-label">Off</span>
      </button>
    </div>
  );
}
