import { tideColors } from '@core/map/tideStyle';
import type { TideGraphModel } from '@core/tides/levels';
import { useDisplayScale } from '@ui/displayScale';
import { useTheme } from '@ui/paper';
import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

/**
 * The tide card's graph (#764, mockup approved 2026-10-16): the observed
 * past solid, the predicted curve dashed over 8 h back and 16 h ahead, the
 * "now" line and dot, the next high and low labelled, heights in the unit
 * setting (`tideGraph` builds every number; this only draws).
 */
export function TideGraph({ model, datum }: { model: TideGraphModel; datum: string }) {
  const theme = useTheme();
  const { sz } = useDisplayScale();
  const [w, setW] = useState(0);
  const c = tideColors(theme.dark ? 'dark' : 'light');
  const ink = theme.colors.onSurface;
  const muted = theme.colors.onSurfaceVariant;
  const grid = theme.colors.outlineVariant;
  const H = sz(128);
  const padL = sz(22);
  const padT = sz(18);
  const padB = sz(28);
  const fs = sz(10);
  const t0 = -8;
  const t1 = 16;
  const X = (t: number) => padL + ((t - t0) / (t1 - t0)) * (w - padL);
  const Y = (v: number) =>
    padT + (1 - (v - model.yMin) / (model.yMax - model.yMin || 1)) * (H - padT - padB);
  const path = (pts: readonly { t: number; v: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const onlyPredicted = model.observed.length === 0;
  const summary = [
    `Tide graph, ${model.unit} above ${datum}`,
    ...model.marks.map((m) => m.label),
  ].join('. ');
  return (
    <View
      style={{ height: H }}
      onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
      accessible
      accessibilityLabel={summary}
      testID="tide-graph"
    >
      {w > 0 && (
        <Svg width={w} height={H}>
          {model.yTicks.map((v) => (
            <Line
              key={`g${v}`}
              x1={padL}
              x2={w}
              y1={Y(v)}
              y2={Y(v)}
              stroke={grid}
              strokeWidth={1}
            />
          ))}
          {model.yTicks.map((v) => (
            <SvgText
              key={`y${v}`}
              x={padL - sz(4)}
              y={Y(v) + fs * 0.35}
              fontSize={fs}
              fill={muted}
              textAnchor="end"
            >
              {Number.isInteger(v) ? String(v) : v.toFixed(1)}
            </SvgText>
          ))}
          <SvgText x={0} y={fs} fontSize={fs} fill={muted}>
            {`${model.unit} above ${datum}`}
          </SvgText>
          {model.xTicks.map((x) => (
            <SvgText
              key={`x${x.t}`}
              x={X(x.t)}
              y={H - sz(3)}
              fontSize={fs}
              fill={muted}
              textAnchor="middle"
            >
              {x.label}
            </SvgText>
          ))}
          {model.predicted.length > 1 && (
            <Path
              d={path(model.predicted)}
              fill="none"
              stroke={c.station}
              strokeOpacity={onlyPredicted ? 1 : 0.6}
              strokeWidth={onlyPredicted ? 1.8 : 1.5}
              strokeDasharray="4 3"
            />
          )}
          {model.observed.length > 1 && (
            <Path
              d={path(model.observed)}
              fill="none"
              stroke={c.station}
              strokeWidth={2.2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          <Line
            x1={X(0)}
            x2={X(0)}
            y1={padT - sz(6)}
            y2={H - padB}
            stroke={ink}
            strokeOpacity={0.55}
            strokeWidth={1}
          />
          <SvgText
            x={X(0)}
            y={padT - sz(8)}
            fontSize={fs}
            fill={ink}
            fontWeight="700"
            textAnchor="middle"
          >
            now
          </SvgText>
          {model.lastObserved !== null && (
            <Circle
              cx={X(model.lastObserved.t)}
              cy={Y(model.lastObserved.v)}
              r={sz(3)}
              fill={c.station}
              opacity={0.55}
            />
          )}
          {model.marks.map((m) => (
            <Circle key={`m${m.t}`} cx={X(m.t)} cy={Y(m.v)} r={sz(2.5)} fill={c.station} />
          ))}
          {model.marks.map((m) => (
            <SvgText
              key={`l${m.t}`}
              x={X(m.t)}
              y={m.kind === 'high' ? Y(m.v) - sz(6) : Y(m.v) + sz(13)}
              fontSize={fs}
              fill={ink}
              textAnchor={X(m.t) > w - sz(50) ? 'end' : 'middle'}
            >
              {m.label}
            </SvgText>
          ))}
          {model.now !== null && (
            <Circle
              cx={X(0)}
              cy={Y(model.now.v)}
              r={sz(4)}
              fill={
                model.lastObserved === null && !onlyPredicted ? c.station : theme.colors.surface
              }
              stroke={c.station}
              strokeWidth={2}
            />
          )}
        </Svg>
      )}
    </View>
  );
}
