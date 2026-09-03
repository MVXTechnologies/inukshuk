import { estimateTextWidth } from '@core/chart/axis';
import type { ActivityBucket } from '@core/dashboard/aggregate';
import { act, render, screen } from '@testing-library/react-native';
import { ActivityGraph } from './ActivityGraph';

/**
 * Regression cover for the clipped y axis.
 *
 * The distance labels live in the left gutter, RIGHT-anchored against the axis
 * line, so a label wider than the gutter runs off the left of the SVG viewport
 * and the leading glyphs are clipped away — which is how a two-digit weekly
 * total came out reading "0.00 km" instead of "10.00 km" and got the Dashboard
 * pulled from the store screenshot set.
 *
 * The invariant asserted here is the one that was violated: every label the
 * chart actually draws must start at x >= 0.
 */

const mockUnits = { units: 'metric' as 'metric' | 'imperial' };
jest.mock('@state/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ units: mockUnits.units }) },
}));

const DAY = 86_400_000;
const WIDTH = 360;

function bucketsPeaking(maxDistanceM: number): ActivityBucket[] {
  const start = new Date(2026, 0, 5).getTime();
  // A rising ramp, so the last bucket is the period max and the gridlines land
  // at round fractions of it.
  return Array.from({ length: 7 }, (_, i) => ({
    startMs: start + i * DAY,
    endMs: start + (i + 1) * DAY,
    distanceM: (maxDistanceM * (i + 1)) / 7,
    movingTimeS: 3600,
    ascentM: 100,
    trackIds: [`t${i}`],
  }));
}

async function renderGraph(maxDistanceM: number): Promise<void> {
  await render(
    <ActivityGraph
      buckets={bucketsPeaking(maxDistanceM)}
      selectedIndex={6}
      onSelect={() => undefined}
      accent="#c62f2f"
    />,
  );
  // The chart draws nothing until it has measured itself.
  await act(async () => {
    screen.getByLabelText('Activity graph').props.onLayout({
      nativeEvent: { layout: { width: WIDTH, height: 168 } },
    });
  });
}

interface DrawnLabel {
  text: string;
  x: number;
  fontSize: number;
}

interface SvgNode {
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown;
}

/**
 * The y-axis labels as react-native-svg lays them out: `RNSVGText` nodes whose
 * font is right-anchored (the x-axis day/month labels anchor middle or start,
 * so the anchor separates the two bands), with the string in a child tspan.
 */
function axisLabels(): DrawnLabel[] {
  const out: DrawnLabel[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const n = node as SvgNode;
    const props = n.props ?? {};
    const font = props['font'] as { fontSize?: number; textAnchor?: string } | undefined;
    if (n.type === 'RNSVGText' && font?.textAnchor === 'end') {
      const xs = props['x'] as number[] | undefined;
      const child = (Array.isArray(n.children) ? n.children[0] : undefined) as SvgNode | undefined;
      const content = child?.props?.['content'];
      out.push({
        text: typeof content === 'string' ? content : '',
        x: xs?.[0] ?? 0,
        fontSize: font.fontSize ?? 0,
      });
    }
    walk(n.children);
  };
  walk(screen.toJSON());
  return out;
}

/**
 * The labels whose left edge falls outside the viewport — the ones the SVG
 * clips. Reported as `"10.00 km" starts at -2.2` so a failure names the string.
 */
function clipped(labels: DrawnLabel[]): string[] {
  return labels
    .map(({ text, x, fontSize }) => ({ text, left: x - estimateTextWidth(text, fontSize) }))
    .filter(({ left }) => left < 0)
    .map(({ text, left }) => `"${text}" starts at ${left.toFixed(1)}`);
}

describe('ActivityGraph y-axis labels', () => {
  afterEach(() => {
    mockUnits.units = 'metric';
  });

  it.each([
    ['single-digit km', 9_000, 'metric', '3.00 km'],
    ['two-digit km — the reported bug', 90_000, 'metric', '30.00 km'],
    ['three-digit km — a long trip', 900_000, 'metric', '300.00 km'],
    ['imperial miles', 200_000, 'imperial', '43.5 mi'],
    ['three-digit imperial miles', 700_000, 'imperial', '186.4 mi'],
  ] as const)('draws %s fully inside the viewport', async (_name, max, units, expected) => {
    mockUnits.units = units;
    await renderGraph(max);

    const labels = axisLabels();
    expect(labels.map((l) => l.text)).toContain(expected);
    expect(clipped(labels)).toEqual([]);
  });

  it('keeps the gutter tight for short labels instead of always reserving the widest', async () => {
    await renderGraph(9_000);
    const narrow = Math.max(...axisLabels().map((l) => l.x));
    await renderGraph(900_000);
    const wide = Math.max(...axisLabels().map((l) => l.x));
    expect(wide).toBeGreaterThan(narrow);
  });
});
