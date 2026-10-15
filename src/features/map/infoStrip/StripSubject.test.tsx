/**
 * Owner, 2.6.0: "when adding a distance in the bar to something, it should
 * say to what, or at least show the same target icon". The cell side of
 * `@core/infoStrip/subject`: StripField draws the subject's icon (a saved
 * waypoint's own pin) and, with room, its name; the strip names each target
 * once and reads "Distance to <name>: 3.2 km" to screen readers.
 */
import { computeRows } from '@core/infoStrip/compute';
import { ref } from '@core/infoStrip/presets';
import type { DepsSnapshot, StripSubject, StripValue } from '@core/infoStrip/types';
import { METRIC as METRIC_UNITS } from '@core/format';
import { darkScheme, lightScheme } from '@ui/tokens';
import { darkTheme, lightTheme } from '@ui/theme';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { PixelRatio, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { InfoStripView } from './InfoStrip';
import { StripField } from './StripField';

const LAC: StripSubject = {
  key: 'waypoint:w1',
  name: 'Lac-Beauport',
  glyph: 'place',
  pin: { icon: 'camp', color: '#E8612C' },
};
/** The icon is decorative (the cell's label names it): hidden from screen readers. */
const HIDDEN = { includeHiddenElements: true };
const DEST: StripSubject = { key: 'destination', name: 'Destination', glyph: 'flag' };

function Field({
  value,
  dark = false,
  caption,
}: {
  value: StripValue;
  dark?: boolean;
  caption?: boolean;
}) {
  return (
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <StripField value={value} fit caption={caption} testID="f" textTestID="t" />
    </PaperProvider>
  );
}

const layout = (width: number) =>
  fireEvent(screen.getByTestId('f'), 'layout', { nativeEvent: { layout: { width, height: 30 } } });

describe('StripField: says what a reading is to', () => {
  beforeEach(() => jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1));
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('a wide cell names it beside its pin, in theme ink (%s)', async (_n, dark, s) => {
    await render(<Field value={{ value: '3.20', unit: 'km', subject: LAC }} dark={dark} />);
    // Before layout: the pin, no name yet, the value whole.
    expect(screen.getByTestId('strip-subject-pin', HIDDEN)).toBeOnTheScreen();
    expect(screen.queryByTestId('strip-subject-caption')).toBeNull();
    await layout(200);
    const caption = screen.getByTestId('strip-subject-caption');
    expect(caption).toHaveTextContent('Lac-Beauport');
    expect(caption.props.numberOfLines).toBe(1);
    expect(caption.props.ellipsizeMode).toBe('tail');
    expect(StyleSheet.flatten(caption.props.style).color).toBe(s.inkVariant);
    // The value never gives way to the name: the name is what ellipsises.
    expect(screen.getByTestId('t')).toHaveTextContent('3.20 km');
    expect(StyleSheet.flatten(screen.getByTestId('t').props.style).flexShrink).toBe(0);
  });

  it('too narrow for the name: the pin alone, the value whole', async () => {
    await render(<Field value={{ value: '3.20', unit: 'km', subject: LAC }} />);
    await layout(70);
    expect(screen.queryByTestId('strip-subject-caption')).toBeNull();
    expect(screen.getByTestId('strip-subject-pin', HIDDEN)).toBeOnTheScreen();
    expect(screen.getByTestId('t')).toHaveTextContent(/^3\.20/);
  });

  it('named elsewhere in the strip: the icon only, however wide', async () => {
    await render(<Field value={{ tag: 'ETE', value: '0:21', subject: DEST }} caption={false} />);
    await layout(300);
    expect(screen.queryByTestId('strip-subject-caption')).toBeNull();
    // No pin of its own: the target's glyph (the destination flag).
    expect(screen.getByTestId('strip-subject-glyph', HIDDEN)).toBeOnTheScreen();
    expect(screen.queryByTestId('strip-subject-pin', HIDDEN)).toBeNull();
    expect(screen.getByText('ETE')).toBeOnTheScreen();
    expect(screen.getByTestId('t')).toHaveTextContent('0:21');
  });

  it("the target name draws its target's pin in place of its glyph", async () => {
    await render(
      <Field value={{ glyph: 'place', value: 'Lac-Beauport', subject: LAC, namesSubject: true }} />,
    );
    await layout(200);
    expect(screen.getByTestId('strip-subject-pin', HIDDEN)).toBeOnTheScreen();
    expect(screen.queryByTestId('strip-subject-caption')).toBeNull();
    expect(screen.getByTestId('t')).toHaveTextContent('Lac-Beauport');
  });

  it('a field with no subject draws as before', async () => {
    await render(<Field value={{ glyph: 'speed', value: '3.6', unit: 'km/h' }} />);
    await layout(200);
    expect(screen.queryByTestId('strip-subject-pin', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('strip-subject-glyph', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('strip-subject-caption')).toBeNull();
  });
});

describe('InfoStripView: a target named once, spoken by name', () => {
  const CAMP = { latitude: 46.8222, longitude: -71.1952 };
  const data: DepsSnapshot = {
    nowMs: Date.UTC(2026, 9, 13, 15, 0),
    centre: null,
    centreElevationM: null,
    followsUser: false,
    position: {
      latitude: 46.81394,
      longitude: -71.20761,
      altitudeM: 200,
      accuracyM: 4,
      speedMps: 1,
    },
    headingDeg: null,
    headingReference: null,
    course: null,
    movingSpeedMps: 1.2,
    navTarget: { name: 'Camp lac', point: CAMP, waypointId: 'w1', pin: { color: '#1E64C8' } },
    cursor: null,
    follow: null,
    waypoints: {},
    recording: null,
    coordinateFormat: 'dd',
    datums: {},
    gnss: null,
    tides: {},
  };
  const ctx = { units: METRIC_UNITS, target: { kind: 'navTarget' } as const };

  const view = (rows: ReturnType<typeof computeRows>) => (
    <PaperProvider theme={lightTheme}>
      <InfoStripView
        rows={rows}
        dock="bottom"
        onPanel={false}
        topInset={0}
        onEdit={() => undefined}
        onCopy={() => undefined}
      />
    </PaperProvider>
  );

  it('reads "Distance to <name>: 3.2 km"', async () => {
    const rows = computeRows([[ref('targetDistance'), ref('ete')]], data, ctx);
    await render(view(rows));
    const dist = rows[0]![0]!.value;
    expect(screen.getByTestId('strip-field-targetDistance').props.accessibilityLabel).toBe(
      `Distance to Camp lac: ${dist.value} ${dist.unit}`,
    );
    expect(screen.getByTestId('strip-field-ete').props.accessibilityLabel).toMatch(
      /^Time to Camp lac: ≈\d+:\d\d$/,
    );
  });

  it('the first field to a target may name it; the rest, and all beside its name field, show the icon', async () => {
    // Each cell laid out roomy: only the plan decides who names the target.
    const captioned = async (ids: string[]) => {
      for (const id of ids) {
        const field = screen.getByTestId(`strip-field-${id}`).children[0];
        if (field === undefined || typeof field === 'string') throw new Error(id);
        await fireEvent(field, 'layout', { nativeEvent: { layout: { width: 300, height: 30 } } });
      }
      return ids.map(
        (id) =>
          within(screen.getByTestId(`strip-field-${id}`)).queryByTestId('strip-subject-caption') !==
          null,
      );
    };
    await render(view(computeRows([[ref('targetDistance'), ref('ete')]], data, ctx)));
    expect(await captioned(['targetDistance', 'ete'])).toEqual([true, false]);
    await render(
      view(computeRows([[ref('targetDistance')], [ref('targetName'), ref('eta')]], data, ctx)),
    );
    expect(await captioned(['targetDistance', 'targetName', 'eta'])).toEqual([false, false, false]);
    // Both draw the saved waypoint's own pin.
    expect(screen.getAllByTestId('strip-subject-pin', HIDDEN)).toHaveLength(3);
  });
});
