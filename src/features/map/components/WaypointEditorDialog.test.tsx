import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { WaypointEditorDialog } from './WaypointEditorDialog';

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('@data/storage', () => ({ newId: () => 'id', importPhoto: jest.fn() }));

/**
 * #232 — the form grew a Name field at the top, pre-filled with the auto
 * number so a name left alone numbers exactly as it always did. The dialog
 * itself is a controlled form: the caller owns both drafts, and the store
 * decides what a blank name means.
 */
async function setup(name = 'Waypoint 7') {
  const handlers = {
    onChangeName: jest.fn(),
    onChangeDraft: jest.fn(),
    onSave: jest.fn(),
    onDelete: jest.fn(),
    onSetPhoto: jest.fn(),
  };
  await render(
    <PaperProvider>
      <WaypointEditorDialog waypoint={{ label: name }} name={name} draft="" {...handlers} />
    </PaperProvider>,
  );
  return handlers;
}

describe('WaypointEditorDialog Name field (#232)', () => {
  it('renders the Name field pre-filled with the auto number', async () => {
    await setup();
    const field = await screen.findByLabelText('Waypoint name');
    expect(field.props.value).toBe('Waypoint 7');
    // ... and the note field it has always had, still there (Paper's floating
    // label is a sibling Text, so the placeholder is what identifies it).
    expect(screen.getByPlaceholderText("What's here?")).toBeOnTheScreen();
  });

  it('does not echo the name in the dialog title — one element owns it', async () => {
    await setup();
    // A title reading "Waypoint 7" too would be a second element answering to
    // the same string (screen readers, and Maestro's waypoint flow).
    expect(await screen.findByText('Waypoint')).toBeOnTheScreen();
    expect(screen.queryAllByText('Waypoint 7')).toHaveLength(0);
  });

  it('reports the typed name up to the caller, which submits it', async () => {
    const handlers = await setup();
    const field = await screen.findByLabelText('Waypoint name');
    await act(async () => {
      fireEvent.changeText(field, 'Refuge du Lac');
    });
    expect(handlers.onChangeName).toHaveBeenCalledWith('Refuge du Lac');

    // Two "Done"s on screen: the shared iOS keyboard accessory bar (#235),
    // then the dialog's own action. The dialog's is the last one.
    const dones = screen.getAllByText('Done');
    fireEvent.press(dones[dones.length - 1]!);
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });

  // #235/#240 — a single-line field on iOS has no "hide keyboard" key, so
  // Return has to be wired; here it just puts the keyboard away.
  it('dismisses the keyboard on Return without closing the dialog', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const handlers = await setup();
    const field = await screen.findByLabelText('Waypoint name');
    expect(field.props.returnKeyType).toBe('done');
    await act(async () => {
      fireEvent(field, 'submitEditing');
    });
    expect(dismiss).toHaveBeenCalled();
    expect(handlers.onSave).not.toHaveBeenCalled();
    dismiss.mockRestore();
  });

  it('carries a name the user has already chosen, not just the auto one', async () => {
    await setup('Camp du ruisseau');
    const field = await screen.findByLabelText('Waypoint name');
    expect(field.props.value).toBe('Camp du ruisseau');
  });
});
