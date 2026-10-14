/**
 * The info strip's editor (#673, mockup §3/§6/§7): add, remove, drag and
 * reorder, the field picker (only what fits), generated field settings,
 * the map aids, presets (with a missing extension), and your own strips.
 */
import { DEFAULT_POINTING_LINE } from '@core/map/pointingLineSettings';
import { DEFAULT_STRIP } from '@core/infoStrip/presets';
import { MAX_SAVED_STRIPS } from '@core/infoStrip/settings';
import type { InfoStrip } from '@core/infoStrip/types';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { darkScheme, lightScheme } from '@ui/tokens';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { BackHandler, StyleSheet } from 'react-native';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { State } from 'react-native-gesture-handler';

import { InfoStripHost } from '../InfoStripHost';
import { openStripEditor, useStripRuntime } from '../stripRuntime';
import { SAVED_LIMIT_MESSAGE } from './InfoStripEditor';
import { currentStrip, Providers, putStrip, QC, resetStores } from '../testUtils';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('../../dem', () => ({
  fetchDemTile: jest.fn(async () => new Float32Array(256 * 256).fill(212)),
}));
jest.mock('../../useCompass', () => ({ subscribeHeading: () => () => undefined }));

const fields = () => currentStrip().rows.map((r) => r.map((f) => f.field));

async function openEditor(dark = false, over: { bottomLift?: number; focused?: boolean } = {}) {
  await render(
    <Providers dark={dark}>
      <InfoStripHost
        location={QC}
        fix={{ altitude: 200, accuracy: 4, speed: 1 }}
        follow={null}
        recording={null}
        bottomLift={over.bottomLift ?? 0}
        focused={over.focused ?? true}
        hidden={false}
        onCopied={() => undefined}
        onOpenTarget={() => undefined}
      />
    </Providers>,
  );
  await act(async () => openStripEditor());
}

const tap = (label: string | RegExp) => fireEvent.press(screen.getByLabelText(label));

beforeEach(() => {
  resetStores();
  mockPush.mockClear();
  useSettingsStore.setState({ pointingLine: DEFAULT_POINTING_LINE });
  useLibraryStore.setState({ waypoints: [] });
});

describe('the editor sheet', () => {
  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('is a plain themed sheet (no Portal) in %s', async (_n, dark, scheme) => {
    await openEditor(dark);
    const sheet = screen.getByTestId('strip-editor');
    expect(StyleSheet.flatten(sheet.props.style)).toMatchObject({
      position: 'absolute',
      backgroundColor: scheme.surface,
    });
    expect(screen.getByText('Info strip')).toBeOnTheScreen();
    expect(screen.getAllByText('Default').length).toBeGreaterThan(0);
    expect(screen.getByText(/^rows · 1 of 3$/i)).toBeOnTheScreen();
  });

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('every page inks with the %s theme', async (_n, dark, scheme) => {
    const inkOf = (text: string) =>
      StyleSheet.flatten(screen.getAllByText(text)[0]!.props.style).color as string;
    await openEditor(dark);
    expect(inkOf('Info strip')).toBe(scheme.ink);
    // The picker.
    await fireEvent.press(screen.getByTestId('strip-add-field-0'));
    expect(inkOf('Add to row 1')).toBe(scheme.ink);
    expect(inkOf('Speed')).toBe(scheme.ink);
    await tap('Close the field picker');
    // A field's settings page.
    await fireEvent.press(screen.getByTestId('strip-edit-field-0-0'));
    expect(inkOf('Coordinates')).toBe(scheme.ink);
    await tap('Back to info strip');
    // The centre cursor.
    await tap('Centre cursor');
    expect(inkOf('Centre cursor')).toBe(scheme.ink);
    await tap('Back to info strip');
    // Presets.
    await tap('Presets');
    expect(inkOf('Hiking')).toBe(scheme.ink);
    expect(inkOf('Next on trail, time to it, altitude, sunset')).toBe(scheme.inkMuted);
  });

  it('Done (or the dimmed map) closes it', async () => {
    await openEditor();
    await tap('Done editing the info strip');
    expect(useStripRuntime.getState().editorOpen).toBe(false);
    await act(async () => openStripEditor());
    // The dim is outside the modal sheet: hidden from screen readers, still a touch target.
    const dim = screen.getByTestId('strip-editor-backdrop', { includeHiddenElements: true });
    await fireEvent.press(dim);
    expect(screen.queryByTestId('strip-editor')).toBeNull();
  });

  it('switches the dock', async () => {
    await openEditor();
    await tap('Top');
    expect(currentStrip().dock).toBe('top');
    await tap('Bottom');
    expect(currentStrip().dock).toBe('bottom');
  });
});

describe('editing rows', () => {
  it('adds a field where a space is free, through the picker, and marks the preset edited', async () => {
    await openEditor();
    // Coordinates (2) + elevation (1): one space left, so a + shows.
    await fireEvent.press(screen.getByTestId('strip-add-field-0'));
    expect(screen.getByText('Add to row 1')).toBeOnTheScreen();
    // Only fields that fit: coordinates (2 spaces) is not listed, and nothing is greyed.
    expect(screen.queryByTestId('strip-pick-coords')).toBeNull();
    expect(screen.getByText(/Row 1 has 1 space left/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('strip-pick-speed'));
    expect(fields()).toEqual([['coords', 'elevation', 'speed']]);
    // Full now: no + in that row.
    expect(screen.queryByTestId('strip-add-field-0')).toBeNull();
    expect(screen.getAllByText('Default · edited').length).toBeGreaterThan(0);
  });

  it('searches and filters by group', async () => {
    await openEditor();
    await fireEvent.press(screen.getByTestId('strip-add-row'));
    expect(screen.getByText('Add a row')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId('strip-field-search'), 'how far');
    expect(screen.getByTestId('strip-pick-targetDistance')).toBeOnTheScreen();
    expect(screen.queryByTestId('strip-pick-speed')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('strip-field-search'), '');
    await tap('Motion fields');
    expect(screen.getByTestId('strip-pick-speed')).toBeOnTheScreen();
    expect(screen.queryByTestId('strip-pick-coords')).toBeNull();
    // Extension fields are not listed without their extension.
    await tap('All fields');
    expect(screen.queryByTestId('strip-pick-tides:level')).toBeNull();
    await fireEvent.press(screen.getByTestId('strip-pick-coords'));
    expect(fields()).toEqual([['coords', 'elevation'], ['coords']]);
  });

  it('"Add a row" stops at three rows', async () => {
    putStrip('navigation');
    await openEditor();
    expect(screen.getByText(/^rows · 3 of 3$/i)).toBeOnTheScreen();
    expect(screen.queryByTestId('strip-add-row')).toBeNull();
  });

  it('removes with ✕; an emptied row goes', async () => {
    await openEditor();
    await tap('Remove Elevation');
    expect(fields()).toEqual([['coords']]);
    await tap('Remove Coordinates');
    expect(fields()).toEqual([]);
    expect(screen.getByText(/^rows · 0 of 3$/i)).toBeOnTheScreen();
  });

  it('moves fields within and between rows, and reorders rows (screen-reader actions)', async () => {
    putStrip('navigation');
    await openEditor();
    const field = (r: number, i: number) => screen.getByTestId(`strip-edit-field-${r}-${i}`);
    const act11y = (el: ReturnType<typeof field>, actionName: string) =>
      fireEvent(el, 'accessibilityAction', { nativeEvent: { actionName } });
    await act11y(field(0, 0), 'moveRight');
    expect(fields()[0]).toEqual(['targetDistance', 'targetName', 'targetBearing', 'ete']);
    await act11y(field(0, 1), 'moveLeft');
    expect(fields()[0]).toEqual(['targetName', 'targetDistance', 'targetBearing', 'ete']);
    // Row 3 (coords + elevation) has a free space: ETA moves down into it.
    await act11y(field(1, 2), 'moveDown');
    expect(fields()).toEqual([
      ['targetName', 'targetDistance', 'targetBearing', 'ete'],
      ['speed', 'heading', 'declination'],
      ['coords', 'elevation', 'eta'],
    ]);
    // A full row refuses: nothing moves.
    await act11y(field(1, 0), 'moveUp');
    expect(fields()[0]).toHaveLength(4);
    await act11y(screen.getByTestId('strip-row-handle-2'), 'rowUp');
    expect(fields()[1]).toEqual(['coords', 'elevation', 'eta']);
    await act11y(field(0, 3), 'remove');
    expect(fields()[0]).toEqual(['targetName', 'targetDistance', 'targetBearing']);
  });

  it('drags a held field (the gesture, end to end) to a new row', async () => {
    await openEditor();
    // Unmeasured in Jest, every row reads 0 dp tall: any drop point is below
    // the last row, which makes a new one.
    await act(async () =>
      fireGestureHandler(getByGestureTestId('strip-field-drag-0-1'), [
        { state: State.BEGAN, absoluteX: 100, absoluteY: 500 },
        { state: State.ACTIVE, translationY: 60, absoluteX: 100, absoluteY: 560 },
        { state: State.END, translationY: 60, absoluteX: 100, absoluteY: 560 },
      ]),
    );
    expect(fields()).toEqual([['coords'], ['elevation']]);
  });

  it('drags a row by its handle', async () => {
    putStrip('hiking');
    await openEditor();
    const before = fields();
    await act(async () =>
      fireGestureHandler(getByGestureTestId('strip-row-drag-0'), [
        { state: State.BEGAN, absoluteY: 500 },
        { state: State.ACTIVE, absoluteY: 600 },
        { state: State.END, absoluteY: 600 },
      ]),
    );
    expect(fields()).toEqual([before[1], before[0]]);
  });
});

describe('field settings (generated from the params schema)', () => {
  it('coordinates: format (a list: six options), datum, accuracy, copy', async () => {
    await openEditor();
    await fireEvent.press(screen.getByTestId('strip-edit-field-0-0'));
    expect(screen.getByText('Coordinates')).toBeOnTheScreen();
    await tap('DDM');
    expect(currentStrip().rows[0]![0]!.params.format).toBe('ddm');
    await tap('NAD83(CSRS)');
    expect(currentStrip().rows[0]![0]!.params.datum).toBe('csrs');
    await tap('Tap to copy');
    expect(currentStrip().rows[0]![0]!.params.tapToCopy).toBe(false);
    await tap('Back to info strip');
    expect(screen.getByText(/^rows · 1 of 3$/i)).toBeOnTheScreen();
  });

  it("a target field edits the strip's shared target, or its own", async () => {
    useLibraryStore.setState({
      waypoints: [
        { id: 'w1', label: 'Camp lac', latitude: 46.82, longitude: -71.2, createdAt: 0 },
      ] as never,
    });
    putStrip('navigation');
    await openEditor();
    await fireEvent.press(screen.getByTestId('strip-edit-field-0-1'));
    expect(screen.getByText('Distance to target')).toBeOnTheScreen();
    await tap('Next on trail');
    expect(currentStrip().target).toEqual({ kind: 'nextOnTrail' });
    await tap('Waypoint');
    expect(currentStrip().target).toEqual({ kind: 'waypoint', waypointId: 'w1' });
    // Only this field: it takes a copy and the strip keeps its own.
    await tap('Only this field');
    expect(currentStrip().rows[0]![1]!.params.target).toEqual({
      kind: 'waypoint',
      waypointId: 'w1',
    });
    await tap('Nav. target');
    expect(currentStrip().rows[0]![1]!.params.target).toEqual({ kind: 'navTarget' });
    expect(currentStrip().target).toEqual({ kind: 'waypoint', waypointId: 'w1' });
    await tap('Coordinate');
    expect(currentStrip().rows[0]![1]!.params.target).toEqual({ kind: 'coordinate', point: QC });
    await tap('Along the trail');
    expect(currentStrip().rows[0]![1]!.params.measure).toBe('trail');
    await tap('nmi');
    expect(currentStrip().rows[0]![1]!.params.unit).toBe('nmi');
  });
});

describe('map aids', () => {
  it('centre cursor: icon, size, colour, halo, follow', async () => {
    await openEditor();
    await tap('Centre cursor');
    await tap('Crosshair');
    await tap('L');
    await tap('Red');
    await tap('Halo');
    await tap('Hide while the map follows you');
    expect(currentStrip().aids.cursor).toEqual({
      ...DEFAULT_STRIP.aids.cursor,
      kind: 'cross',
      size: 'L',
      color: '#D32F2F',
      halo: false,
      hideWhileFollowing: false,
    });
    await tap('Show centre cursor');
    expect(currentStrip().aids.cursor.enabled).toBe(false);
  });

  it("pointing line: 2.5.1's panel, back to the strip", async () => {
    await openEditor();
    await tap('Options for pointing line');
    await tap('Show pointing line');
    expect(useSettingsStore.getState().pointingLine.enabled).toBe(true);
    await tap('Back to info strip');
    expect(screen.getByText(/^rows · 1 of 3$/i)).toBeOnTheScreen();
  });
});

describe('presets and your strips', () => {
  it('applies a preset at once; Survey brings its crosshair and pointing line', async () => {
    await openEditor();
    await tap('Presets');
    await fireEvent.press(screen.getByTestId('strip-preset-navigation'));
    expect(currentStrip().name).toBe('Navigation');
    expect(fields()).toHaveLength(3);
    await fireEvent.press(screen.getByTestId('strip-preset-survey'));
    // No receiver: its GNSS fields are left out and the rows re-fit.
    expect(fields()).toEqual([
      ['coords', 'accuracy'],
      ['declination'],
      ['targetName', 'targetDistance', 'targetBearing'],
    ]);
    expect(currentStrip().aids.cursor.kind).toBe('cross');
    expect(useSettingsStore.getState().pointingLine).toMatchObject({ enabled: true, length: 500 });
  });

  it('says what a preset needs, with a way to get it (never greyed)', async () => {
    await openEditor();
    await tap('Presets');
    const paddling = screen.getByTestId('strip-preset-paddling');
    expect(within(paddling).getByText('Needs Tide stations')).toBeOnTheScreen();
    await tap('Get Tide stations');
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/settings',
      params: { open: 'extensions', ext: 'tides' },
    });
    expect(useStripRuntime.getState().editorOpen).toBe(false);
  });

  it('saves, applies, renames, duplicates and deletes your strips', async () => {
    putStrip('navigation');
    await openEditor();
    await tap('Presets');
    await fireEvent.press(screen.getByTestId('strip-save-current'));
    await fireEvent.changeText(screen.getByTestId('strip-name-input'), 'Ridge survey');
    await tap('Save strip');
    const all = () => useSettingsStore.getState().infoStrip;
    expect(all().saved.map((s) => s.name)).toEqual(['Ridge survey']);
    expect(currentStrip().name).toBe('Ridge survey');
    // Your own now: no "· edited". Its map aids include the pointing line.
    expect(currentStrip().basedOn).toBeUndefined();
    expect(all().saved[0]!.aids.pointingLine).toEqual(DEFAULT_POINTING_LINE);

    await tap('More for Ridge survey');
    await fireEvent.press(screen.getByText('Duplicate'));
    expect(all().saved.map((s) => s.name)).toEqual(['Ridge survey', 'Ridge survey 2']);
    await tap('More for Ridge survey 2');
    await fireEvent.press(screen.getByText('Rename'));
    await fireEvent.changeText(screen.getByTestId('strip-name-input'), 'Kayak');
    await tap('Save strip');
    expect(all().saved.map((s) => s.name)).toEqual(['Ridge survey', 'Kayak']);

    await fireEvent.press(screen.getByTestId('strip-preset-default'));
    expect(currentStrip().name).toBe('Default');
    await act(async () =>
      useSettingsStore.setState({ pointingLine: { ...DEFAULT_POINTING_LINE, enabled: true } }),
    );
    await tap('Your strip Kayak');
    expect(currentStrip().name).toBe('Kayak');
    expect(fields()).toHaveLength(3);
    // It brings back the pointing line it was saved with (off).
    expect(useSettingsStore.getState().pointingLine.enabled).toBe(false);

    await tap('More for Kayak');
    await fireEvent.press(screen.getByText('Delete'));
    expect(all().saved.map((s) => s.name)).toEqual(['Ridge survey']);
  });
});

describe('a modal sheet (#673 review)', () => {
  type Back = () => boolean | null | undefined;
  let backs: Back[] = [];
  beforeEach(() => {
    backs = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
      backs.push(h as Back);
      return { remove: () => (backs = backs.filter((x) => x !== h)) };
    });
  });
  afterEach(() => jest.restoreAllMocks());
  const pressBack = async () => {
    let handled: boolean | null | undefined = false;
    await act(async () => {
      handled = backs.at(-1)?.();
    });
    return handled;
  };

  it('Android Back goes up a page, then closes it', async () => {
    await openEditor();
    await tap('Presets');
    expect(screen.getByTestId('strip-save-current')).toBeOnTheScreen();
    expect(await pressBack()).toBe(true);
    expect(screen.queryByTestId('strip-save-current')).toBeNull();
    expect(screen.getByText('Info strip')).toBeOnTheScreen();
    expect(await pressBack()).toBe(true);
    expect(useStripRuntime.getState().editorOpen).toBe(false);
    // Closed: Back is the screen's again.
    expect(backs).toHaveLength(0);
  });

  it('Back is not taken while another tab is in front (tab screens stay mounted)', async () => {
    await openEditor(false, { focused: false });
    expect(screen.getByTestId('strip-editor')).toBeOnTheScreen();
    expect(backs).toHaveLength(0);
  });

  it('keeps screen readers inside the sheet', async () => {
    await openEditor();
    expect(screen.getByTestId('strip-editor').props.accessibilityViewIsModal).toBe(true);
  });

  it('fits between the status bar and the lifted bottom (on the recording panel)', async () => {
    await openEditor(false, { bottomLift: 300 });
    await act(async () =>
      fireEvent(
        screen.getByTestId('strip-editor-backdrop', { includeHiddenElements: true }),
        'layout',
        {
          nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 740 } },
        },
      ),
    );
    const sheet = StyleSheet.flatten(screen.getByTestId('strip-editor').props.style);
    expect(sheet.bottom).toBe(300);
    // 740 of map, 300 under the sheet, 40 of status bar.
    expect(sheet.maxHeight).toBe(740 - 300 - 40);
  });
});

describe('your strips: UNDO a delete, and the limit says so', () => {
  const saved = (n: number): InfoStrip[] =>
    Array.from({ length: n }, (_, i) => ({ ...DEFAULT_STRIP, name: `Strip ${i + 1}` }));
  const putSaved = (list: InfoStrip[]) =>
    useSettingsStore.setState({
      infoStrip: { ...useSettingsStore.getState().infoStrip, saved: list },
    });
  const names = () => useSettingsStore.getState().infoStrip.saved.map((s) => s.name);

  it('a delete offers UNDO, which puts it back where it was', async () => {
    putSaved(saved(3));
    await openEditor();
    await tap('Presets');
    await tap('More for Strip 2');
    await fireEvent.press(screen.getByText('Delete'));
    expect(names()).toEqual(['Strip 1', 'Strip 3']);
    expect(screen.getByTestId('action-snackbar')).toHaveTextContent(/Deleted “Strip 2”/);
    await tap('Undo');
    expect(names()).toEqual(['Strip 1', 'Strip 2', 'Strip 3']);
    expect(screen.queryByTestId('action-snackbar')).toBeNull();
  });

  it('saving at the limit refuses with a message, never dropping your oldest strip', async () => {
    putSaved(saved(MAX_SAVED_STRIPS));
    await openEditor();
    await tap('Presets');
    await fireEvent.press(screen.getByTestId('strip-save-current'));
    expect(screen.queryByTestId('strip-name-input')).toBeNull();
    expect(screen.getByTestId('action-snackbar')).toHaveTextContent(SAVED_LIMIT_MESSAGE);
    expect(names()).toHaveLength(MAX_SAVED_STRIPS);
    expect(names()[0]).toBe('Strip 1');
  });

  it('a save that reaches the limit while the name is typed is refused too', async () => {
    putSaved(saved(MAX_SAVED_STRIPS - 1));
    await openEditor();
    await tap('Presets');
    await fireEvent.press(screen.getByTestId('strip-save-current'));
    await act(async () => putSaved(saved(MAX_SAVED_STRIPS)));
    await tap('Save strip');
    expect(screen.getByTestId('action-snackbar')).toHaveTextContent(SAVED_LIMIT_MESSAGE);
    expect(names()).toHaveLength(MAX_SAVED_STRIPS);
    expect(names()[0]).toBe('Strip 1');
  });

  it('Duplicate at the limit says so too', async () => {
    putSaved(saved(MAX_SAVED_STRIPS));
    await openEditor();
    await tap('Presets');
    await tap('More for Strip 1');
    await fireEvent.press(screen.getByText('Duplicate'));
    expect(names()).toHaveLength(MAX_SAVED_STRIPS);
    expect(screen.getByTestId('action-snackbar')).toHaveTextContent(SAVED_LIMIT_MESSAGE);
  });
});
