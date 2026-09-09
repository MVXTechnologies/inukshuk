import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as storage from '@data/storage';
import * as ImagePicker from 'expo-image-picker';
import { Keyboard } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { WaypointEditorDialog } from './WaypointEditorDialog';

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

/**
 * #232 — the form grew a Name field at the top, pre-filled with the auto
 * number so a name left alone numbers exactly as it always did. The dialog
 * itself is a controlled form: the caller owns both drafts, and the store
 * decides what a blank name means.
 */
async function setup(name = 'Waypoint 7', photoUri?: string) {
  const handlers = {
    onChangeName: jest.fn(),
    onChangeDraft: jest.fn(),
    onSave: jest.fn(),
    onDelete: jest.fn(),
    onSetPhoto: jest.fn(),
  };
  await render(
    <PaperProvider>
      <WaypointEditorDialog
        waypoint={{ label: name, photoUri }}
        name={name}
        draft="Keep this note"
        {...handlers}
      />
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

describe('waypoint persistence failure feedback', () => {
  it.each(['Done', 'Delete'])(
    'keeps drafts available and permits retry after %s fails',
    async (action) => {
      const handlers = await setup('Spring');
      const handler = action === 'Done' ? handlers.onSave : handlers.onDelete;
      handler.mockImplementationOnce(() => {
        throw new Error('Storage is full. Try again.');
      });
      const buttons = await screen.findAllByText(action);
      await act(async () => {
        fireEvent.press(buttons[buttons.length - 1]!);
      });

      expect(await screen.findByText('Storage is full. Try again.')).toBeOnTheScreen();
      expect(screen.getByLabelText('Waypoint name').props.value).toBe('Spring');
      expect(screen.getByPlaceholderText("What's here?").props.value).toBe('Keep this note');
      await act(async () => {
        fireEvent.press(buttons[buttons.length - 1]!);
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Storage is full. Try again.')).toBeNull();
    },
  );

  it('shows a failed photo removal and leaves the original photo available', async () => {
    const handlers = await setup('Spring', 'file://photos/old.jpg');
    handlers.onSetPhoto.mockImplementationOnce(() => {
      throw new Error('Photo was not saved.');
    });
    await act(async () => {
      fireEvent.press(await screen.findByText('Remove photo'));
    });
    expect(await screen.findByText('Photo was not saved.')).toBeOnTheScreen();
    expect(screen.getByText('Remove photo')).toBeOnTheScreen();
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  });

  it('retains and retries the same imported photo after an uncertain checkpoint commit', async () => {
    const handlers = await setup('Spring');
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file://picker/photo.jpg', width: 10, height: 10 }],
    });
    jest.mocked(storage.importPhoto).mockResolvedValue('file://photos/new.jpg');
    handlers.onSetPhoto.mockImplementationOnce(() => {
      throw new Error('Photo was not saved.');
    });

    await act(async () => {
      fireEvent.press(await screen.findByText('Photo'));
    });
    expect(await screen.findByText('Photo was not saved.')).toBeOnTheScreen();
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
    expect(handlers.onSetPhoto).toHaveBeenCalledWith('file://photos/new.jpg');
    expect(handlers.onSave).not.toHaveBeenCalled();
    handlers.onSetPhoto.mockImplementationOnce(() => {
      throw new Error('Still unable to save.');
    });
    const dones = screen.getAllByText('Done');
    await act(async () => {
      fireEvent.press(dones[dones.length - 1]!);
    });
    expect(handlers.onSave).not.toHaveBeenCalled();
    expect(await screen.findByText('Still unable to save.')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByText('Retry photo'));
    });
    expect(handlers.onSetPhoto).toHaveBeenLastCalledWith('file://photos/new.jpg');
    expect(handlers.onSetPhoto).toHaveBeenCalledTimes(3);
    expect(storage.importPhoto).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Retry photo')).toBeNull();
    await act(async () => {
      fireEvent.press(dones[dones.length - 1]!);
    });
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });
});
