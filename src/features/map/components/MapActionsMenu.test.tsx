import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { MapActionsMenu, type MapActions } from './MapActionsMenu';

async function open(actions: Partial<MapActions> = {}) {
  const all: MapActions = {
    onRecord: jest.fn(),
    onPinMyLocation: jest.fn(),
    onAddWaypoint: jest.fn(),
    ...actions,
  };
  await render(
    <PaperProvider>
      <MapActionsMenu actions={all} open onToggle={jest.fn()} />
    </PaperProvider>,
  );
  return all;
}

describe('MapActionsMenu waypoint rows (#671, #709)', () => {
  it('Pin my location takes the old row’s place; Add waypoint follows it', async () => {
    await open({ onDraw: jest.fn() });
    const labels = screen
      .getAllByLabelText(/^(Record track|Pin my location|Add waypoint|Draw)$/)
      .map((b) => b.props.accessibilityLabel as string);
    expect(labels).toEqual(['Record track', 'Pin my location', 'Add waypoint', 'Draw']);
  });

  it('each row runs its own action', async () => {
    const actions = await open();
    await fireEvent.press(screen.getByLabelText('Pin my location'));
    expect(actions.onPinMyLocation).toHaveBeenCalledTimes(1);
    expect(actions.onAddWaypoint).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('Add waypoint'));
    expect(actions.onAddWaypoint).toHaveBeenCalledTimes(1);
  });

  it('shows "Waiting for a GPS fix…" under Pin my location only, and still runs it', async () => {
    const actions = await open({ pinMyLocationHint: 'Waiting for a GPS fix…' });
    expect(screen.getAllByText('Waiting for a GPS fix…')).toHaveLength(1);
    expect(screen.getByLabelText('Pin my location').props.accessibilityHint).toBe(
      'Waiting for a GPS fix…',
    );
    expect(screen.getByLabelText('Add waypoint').props.accessibilityHint).toBeUndefined();
    await fireEvent.press(screen.getByLabelText('Pin my location'));
    expect(actions.onPinMyLocation).toHaveBeenCalledTimes(1);
  });

  it('has no sub-line once there is a fix', async () => {
    await open();
    expect(screen.queryByText('Waiting for a GPS fix…')).toBeNull();
  });
});
