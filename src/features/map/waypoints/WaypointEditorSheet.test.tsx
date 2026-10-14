import { EMPTY_WAYPOINT_ICON_PREFS } from '@core/library/waypointIconPrefs';
import type { WaypointIcon, WaypointSize } from '@core/models';
import * as storage from '@data/storage';
import { useScreenSheetStore } from '@state/screenSheetStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';
import * as ImagePicker from 'expo-image-picker';
import { BackHandler, Keyboard, StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { WaypointEditorSheet, type WaypointEditorProps } from './WaypointEditorSheet';

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('@data/storage', () => ({
  newId: () => 'id',
  importPhoto: jest.fn(),
  deleteFileAt: jest.fn(),
}));

type Back = () => boolean;
let backHandlers: Back[] = [];
beforeEach(() => {
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
    backHandlers.push(h as Back);
    return { remove: () => (backHandlers = backHandlers.filter((x) => x !== h)) };
  });
  useSettingsStore.setState({ waypointIcons: EMPTY_WAYPOINT_ICON_PREFS });
});
afterEach(() => jest.restoreAllMocks());

const pressBack = () =>
  act(async () => {
    backHandlers[backHandlers.length - 1]?.();
  });

interface Setup {
  name?: string;
  photoUri?: string;
  icon?: WaypointIcon;
  color?: string;
  size?: WaypointSize;
  /** A live recording pin: no icon/colour/size (it becomes a trail note). */
  live?: boolean;
  dark?: boolean;
}

async function setup({ name = 'Waypoint 7', live = false, dark = false, ...wp }: Setup = {}) {
  const handlers = {
    onChangeName: jest.fn(),
    onChangeDraft: jest.fn(),
    onSave: jest.fn(),
    onDelete: jest.fn(),
    onSetPhoto: jest.fn(),
    onSetIcon: jest.fn(),
    onSetStyle: jest.fn(),
  };
  const props: WaypointEditorProps = {
    waypoint: { label: name, ...wp },
    name,
    draft: 'Keep this note',
    ...handlers,
    ...(live ? { onSetIcon: undefined, onSetStyle: undefined } : {}),
  };
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <WaypointEditorSheet {...props} />
    </PaperProvider>,
  );
  return handlers;
}

/** The sheet's own Done (the header's; the keyboard bar has one too, #235). */
const sheetDone = () => screen.getAllByLabelText('Done')[0]!;

describe('WaypointEditorSheet: name and note (#232, kept by #675)', () => {
  it('renders the Name field pre-filled, and the note', async () => {
    await setup();
    expect((await screen.findByLabelText('Waypoint name')).props.value).toBe('Waypoint 7');
    expect(screen.getByPlaceholderText("What's here?").props.value).toBe('Keep this note');
  });

  it('does not echo the name in the title — one element owns it', async () => {
    await setup();
    expect(await screen.findByText('Waypoint')).toBeOnTheScreen();
    expect(screen.queryAllByText('Waypoint 7')).toHaveLength(0);
  });

  it('reports the typed name, and saves on Done', async () => {
    const h = await setup();
    await fireEvent.changeText(await screen.findByLabelText('Waypoint name'), 'Refuge du Lac');
    expect(h.onChangeName).toHaveBeenCalledWith('Refuge du Lac');
    await fireEvent.press(sheetDone());
    expect(h.onSave).toHaveBeenCalledTimes(1);
  });

  it('dismisses the keyboard on Return without closing', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const h = await setup();
    const field = await screen.findByLabelText('Waypoint name');
    expect(field.props.returnKeyType).toBe('done');
    await fireEvent(field, 'submitEditing');
    expect(dismiss).toHaveBeenCalled();
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it('does not open the keyboard by itself: the sheet’s choices stay visible', async () => {
    await setup();
    expect(screen.getByPlaceholderText("What's here?").props.autoFocus).toBeFalsy();
  });

  it('closes, saving, on a scrim tap and on Android Back', async () => {
    const h = await setup();
    await fireEvent.press(screen.getByLabelText('Close waypoint editor'));
    expect(h.onSave).toHaveBeenCalledTimes(1);
    await pressBack();
    expect(h.onSave).toHaveBeenCalledTimes(2);
  });
});

describe('Back and the tab bar follow the host screen’s focus (2.5.1 review)', () => {
  const props = (screenFocused: boolean, onSave = jest.fn()): WaypointEditorProps => ({
    waypoint: { label: 'Waypoint 7' },
    name: 'Waypoint 7',
    onChangeName: jest.fn(),
    draft: '',
    onChangeDraft: jest.fn(),
    onSave,
    onDelete: jest.fn(),
    onSetPhoto: jest.fn(),
    screenFocused,
  });
  const sheet = (p: WaypointEditorProps) => (
    <PaperProvider theme={lightTheme}>
      <WaypointEditorSheet {...p} />
    </PaperProvider>
  );
  const sheetsUp = () => useScreenSheetStore.getState().open;

  beforeEach(() => useScreenSheetStore.setState({ open: 0 }));

  it('takes Back and hides the tab bar while its screen is focused', async () => {
    const onSave = jest.fn();
    const view = await render(sheet(props(true, onSave)));
    expect(backHandlers).toHaveLength(1);
    expect(sheetsUp()).toBe(1);
    await pressBack();
    expect(onSave).toHaveBeenCalledTimes(1);
    await view.unmount();
    expect(backHandlers).toHaveLength(0);
    expect(sheetsUp()).toBe(0);
  });

  it('leaves Back alone and the tab bar up once its screen loses focus (Map → Library)', async () => {
    const onSave = jest.fn();
    const view = await render(sheet(props(true, onSave)));
    await view.rerender(sheet(props(false, onSave)));
    // Back on the other tab navigates: nothing of the hidden editor answers it.
    expect(backHandlers).toHaveLength(0);
    expect(sheetsUp()).toBe(0);
    expect(onSave).not.toHaveBeenCalled();
    // Back on the Map again: the editor is still there and takes Back again.
    await view.rerender(sheet(props(true, onSave)));
    expect(backHandlers).toHaveLength(1);
    expect(sheetsUp()).toBe(1);
    await pressBack();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('registers nothing when it opens on an unfocused screen', async () => {
    await render(sheet(props(false)));
    expect(backHandlers).toHaveLength(0);
    expect(sheetsUp()).toBe(0);
  });

  it('keeps one listener across re-renders (no re-registration per keystroke)', async () => {
    const view = await render(sheet(props(true)));
    const first = backHandlers[0];
    await view.rerender(sheet({ ...props(true), name: 'Waypoint 7b' }));
    expect(backHandlers).toEqual([first]);
    expect(sheetsUp()).toBe(1);
  });
});

describe('persistence failure feedback', () => {
  it.each(['Done', 'Delete'])('keeps drafts and permits retry after %s fails', async (action) => {
    const h = await setup({ name: 'Spring' });
    const handler = action === 'Done' ? h.onSave : h.onDelete;
    handler.mockImplementationOnce(() => {
      throw new Error('Storage is full. Try again.');
    });
    const button = () => (action === 'Done' ? sheetDone() : screen.getByText('Delete'));
    await fireEvent.press(button());
    expect(await screen.findByText('Storage is full. Try again.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Waypoint name').props.value).toBe('Spring');
    await fireEvent.press(button());
    expect(handler).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Storage is full. Try again.')).toBeNull();
  });

  it('shows a failed photo removal and keeps the photo', async () => {
    const h = await setup({ photoUri: 'file://photos/old.jpg' });
    h.onSetPhoto.mockImplementationOnce(() => {
      throw new Error('Photo was not saved.');
    });
    await fireEvent.press(await screen.findByText('Remove photo'));
    expect(await screen.findByText('Photo was not saved.')).toBeOnTheScreen();
    expect(screen.getByText('Remove photo')).toBeOnTheScreen();
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  });

  it('retries the same imported photo after an uncertain commit', async () => {
    const h = await setup();
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file://picker/photo.jpg', width: 10, height: 10 }],
    });
    jest.mocked(storage.importPhoto).mockResolvedValue('file://photos/new.jpg');
    h.onSetPhoto.mockImplementationOnce(() => {
      throw new Error('Photo was not saved.');
    });
    await fireEvent.press(await screen.findByText('Gallery'));
    expect(await screen.findByText('Photo was not saved.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText('Retry photo'));
    expect(h.onSetPhoto).toHaveBeenLastCalledWith('file://photos/new.jpg');
    expect(storage.importPhoto).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Retry photo')).toBeNull();
  });
});

describe('icon (#675)', () => {
  it('starts a new user on suggested icons, with the current one checked', async () => {
    await setup({ icon: 'camp' });
    const row = screen.getByLabelText('Pin icon');
    for (const label of ['Camp', 'Water', 'Parking', 'Summit']) {
      expect(within(row).getByLabelText(label)).toBeOnTheScreen();
    }
    expect(within(row).getByLabelText('Camp').props.accessibilityState).toMatchObject({
      checked: true,
    });
    expect(screen.getByLabelText('All icons')).toBeOnTheScreen();
  });

  it('puts favourites first, then recents, in the quick row', async () => {
    useSettingsStore.setState({ waypointIcons: { favorites: ['fire'], recents: ['bike'] } });
    await setup();
    const row = screen.getByLabelText('Pin icon');
    const labels = within(row)
      .getAllByRole('radio')
      .map((n) => n.props.accessibilityLabel as string);
    expect(labels.slice(0, 2)).toEqual(['Fire', 'Bike']);
  });

  it('picks from the quick row and remembers it as recent on save, not on the tap', async () => {
    const h = await setup();
    const order = () =>
      within(screen.getByLabelText('Pin icon'))
        .getAllByRole('radio')
        .map((t) => t.props.accessibilityLabel as string);
    const before = order();
    await fireEvent.press(screen.getByLabelText('Summit'));
    expect(h.onSetIcon).toHaveBeenCalledWith('summit');
    // Open editor: the recents and the row's order stand still.
    expect(useSettingsStore.getState().waypointIcons.recents).toEqual([]);
    expect(order()).toEqual(before);
    await fireEvent.press(sheetDone());
    expect(useSettingsStore.getState().waypointIcons.recents[0]).toBe('summit');
  });

  it('keeps the recents untouched when the save fails', async () => {
    const h = await setup();
    h.onSave.mockImplementation(() => {
      throw new Error('disk full');
    });
    await fireEvent.press(screen.getByLabelText('Summit'));
    await fireEvent.press(sheetDone());
    expect(useSettingsStore.getState().waypointIcons.recents).toEqual([]);
  });

  it('puts "All icons" right after the tiles (no blank slot)', async () => {
    await setup();
    // The tile strip shrinks to its tiles instead of filling the row.
    const flat = StyleSheet.flatten(screen.getByTestId('waypoint-icon-strip').props.style) as {
      flexGrow?: number;
      flex?: number;
    };
    expect(flat.flexGrow).toBe(0);
    expect(flat.flex).toBeUndefined();
  });

  it('dismisses the keyboard when an icon is picked from the search', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    await setup();
    await fireEvent.press(screen.getByLabelText('All icons'));
    await fireEvent.changeText(await screen.findByLabelText('Search icons'), 'chute');
    dismiss.mockClear();
    await fireEvent.press(screen.getByLabelText('Waterfall'));
    expect(dismiss).toHaveBeenCalled();
    expect(await screen.findByLabelText('Waypoint name')).toBeOnTheScreen();
  });

  it('lays the icon picker out without a blank band, and the results right under the count', async () => {
    await setup();
    await fireEvent.press(screen.getByLabelText('All icons'));
    await screen.findByLabelText('Search icons');
    // The chip strip is a ScrollView: by default it grows and split the page
    // with the list (≈650 dp of blank before the first section).
    const chips = StyleSheet.flatten(screen.getByTestId('icon-picker-chips').props.style) as {
      flexGrow?: number;
    };
    expect(chips.flexGrow).toBe(0);
    // Search results: no empty header row above them.
    await fireEvent.changeText(screen.getByLabelText('Search icons'), 'chute');
    const list = screen.getByTestId('icon-picker-list');
    expect(within(list).queryAllByRole('header')).toHaveLength(0);
  });

  it('opens the full picker, searches in French, picks and returns', async () => {
    const h = await setup();
    await fireEvent.press(screen.getByLabelText('All icons'));
    expect(await screen.findByLabelText('Search icons')).toBeOnTheScreen();
    expect(screen.getByLabelText('Back to waypoint')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Search icons'), 'chute');
    expect(screen.getByText(/icons?$/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Waterfall'));
    expect(h.onSetIcon).toHaveBeenCalledWith('waterfall');
    // Back on the main page.
    expect(await screen.findByLabelText('Waypoint name')).toBeOnTheScreen();
  });

  it('offers the default pin in the picker', async () => {
    const h = await setup({ icon: 'camp' });
    await fireEvent.press(screen.getByLabelText('All icons'));
    await fireEvent.press(await screen.findByLabelText('Default pin'));
    expect(h.onSetIcon).toHaveBeenCalledWith(undefined);
  });

  it('stars an icon on long-press (persisted in settings) and lists favourites on top', async () => {
    await setup();
    await fireEvent.press(screen.getByLabelText('All icons'));
    await fireEvent.changeText(await screen.findByLabelText('Search icons'), 'canoe');
    await fireEvent(screen.getByLabelText('Kayak'), 'longPress');
    expect(useSettingsStore.getState().waypointIcons.favorites).toEqual(['kayak']);
    await fireEvent.changeText(screen.getByLabelText('Search icons'), '');
    expect(screen.getByText('FAVOURITES')).toBeOnTheScreen();
    expect(screen.getByLabelText('Jump to Favourites')).toBeOnTheScreen();
    // A second long-press unstars.
    await fireEvent(screen.getAllByLabelText('Kayak')[0]!, 'longPress');
    expect(useSettingsStore.getState().waypointIcons.favorites).toEqual([]);
  });

  it('Android Back leaves the picker before it closes the sheet', async () => {
    const h = await setup();
    await fireEvent.press(screen.getByLabelText('All icons'));
    expect(await screen.findByLabelText('Search icons')).toBeOnTheScreen();
    await pressBack();
    expect(await screen.findByLabelText('Waypoint name')).toBeOnTheScreen();
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it('mounts only the visible rows of the ~350-icon picker', async () => {
    await setup();
    await fireEvent.press(screen.getByLabelText('All icons'));
    await screen.findByLabelText('Search icons');
    // Virtualized: the first screenfuls, not the whole catalogue.
    expect(screen.getAllByRole('radio').length).toBeLessThan(80);
  });
});

describe('preview and swatches (2.5.1 QA)', () => {
  it('centres the pin and its caption on one line', async () => {
    await setup({ icon: 'camp' });
    const preview = StyleSheet.flatten(screen.getByTestId('waypoint-preview').props.style) as {
      alignItems?: string;
    };
    expect(preview.alignItems).toBe('center');
  });

  it.each([
    ['light', false, 'Paper'],
    ['dark', true, 'Stone'],
  ])('outlines the swatch that melts into the %s sheet', async (_n, dark, name) => {
    await setup({ dark });
    const group = screen.getByLabelText('Pin colour');
    const style = StyleSheet.flatten(within(group).getByLabelText(name).props.style) as {
      borderWidth?: number;
    };
    expect(style.borderWidth).toBe(1);
    // A swatch that stands out on its own gets no outline.
    const red = StyleSheet.flatten(within(group).getByLabelText('Red').props.style) as {
      borderWidth?: number;
    };
    expect(red.borderWidth).toBeUndefined();
  });
});

describe('colour and size (#675)', () => {
  it('offers 18 swatches and picks one', async () => {
    const h = await setup();
    const group = screen.getByLabelText('Pin colour');
    expect(within(group).getAllByRole('radio')).toHaveLength(18);
    await fireEvent.press(within(group).getByLabelText('Orange'));
    expect(h.onSetStyle).toHaveBeenCalledWith({ color: '#E8612C' });
  });

  it('a second tap on the chosen swatch goes back to the default colour', async () => {
    const h = await setup({ color: '#E8612C' });
    const orange = within(screen.getByLabelText('Pin colour')).getByLabelText('Orange');
    expect(orange.props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.press(orange);
    expect(h.onSetStyle).toHaveBeenCalledWith({ color: null });
  });

  it('picks a size; M is the default (no field)', async () => {
    const h = await setup({ size: 'L' });
    await fireEvent.press(screen.getByLabelText('XL'));
    expect(h.onSetStyle).toHaveBeenLastCalledWith({ size: 'XL' });
    await fireEvent.press(screen.getByLabelText('Medium pin'));
    expect(h.onSetStyle).toHaveBeenLastCalledWith({ size: null });
  });

  it('previews the pin with a caption', async () => {
    await setup({ icon: 'camp', color: '#E8612C', size: 'L' });
    expect(screen.getByLabelText('Preview: Camp · Orange · L')).toBeOnTheScreen();
  });

  it('offers no icon, colour or size for a live recording pin', async () => {
    await setup({ live: true });
    expect(screen.queryByLabelText('Pin icon')).toBeNull();
    expect(screen.queryByLabelText('Pin colour')).toBeNull();
    expect(screen.queryByLabelText('All icons')).toBeNull();
    expect(screen.queryByTestId('waypoint-preview')).toBeNull();
    // Name, note and photo stay.
    expect(screen.getByLabelText('Waypoint name')).toBeOnTheScreen();
    expect(screen.getByText('Gallery')).toBeOnTheScreen();
  });
});

describe('both themes', () => {
  const sheetBg = () => {
    const sheet = screen.getByTestId('waypoint-editor-sheet');
    return StyleSheet.flatten(sheet.props.style) as { backgroundColor?: string };
  };

  it('sizes a short editor to its content, capped under the status bar (2.5.1 final QA)', async () => {
    // A recording pin's editor: name, note, photo — no icon, colour or size.
    await setup({ live: true });
    const sheet = StyleSheet.flatten(screen.getByTestId('waypoint-editor-sheet').props.style) as {
      top?: number;
      maxHeight?: number;
      bottom?: number;
    };
    expect(sheet.top).toBeUndefined(); // no fixed top: no blank band
    expect(sheet.bottom).toBe(0);
    expect(sheet.maxHeight).toBeGreaterThan(0); // tall content scrolls instead
    const scroll = StyleSheet.flatten(screen.getByTestId('waypoint-editor-scroll').props.style) as {
      flexGrow?: number;
      flexShrink?: number;
    };
    expect(scroll).toMatchObject({ flexGrow: 0, flexShrink: 1 });
  });

  it('gives the icon picker the full height its list needs', async () => {
    await setup();
    await fireEvent.press(screen.getByLabelText('All icons'));
    await screen.findByLabelText('Search icons');
    const sheet = StyleSheet.flatten(screen.getByTestId('waypoint-editor-sheet').props.style) as {
      top?: number;
    };
    expect(sheet.top).toBeGreaterThan(0);
  });

  it.each([
    ['light', false],
    ['dark', true],
  ])('paints the sheet with the %s surface', async (_name, dark) => {
    await setup({ dark });
    expect(sheetBg().backgroundColor).toBe(schemeTokens(dark).surface);
  });
});
