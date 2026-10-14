import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { MapActionsMenu, type MapActions } from './MapActionsMenu';

async function open(actions: Partial<MapActions> = {}) {
  const all: MapActions = { onRecord: jest.fn(), onAddWaypoint: jest.fn(), ...actions };
  await render(
    <PaperProvider>
      <MapActionsMenu actions={all} open onToggle={jest.fn()} />
    </PaperProvider>,
  );
  return all;
}

describe('MapActionsMenu Add waypoint (#671)', () => {
  it('keeps the row in second place with its label', async () => {
    await open({ onDraw: jest.fn() });
    const labels = screen
      .getAllByLabelText(/^(Record track|Add waypoint|Draw)$/)
      .map((b) => b.props.accessibilityLabel as string);
    expect(labels).toEqual(['Record track', 'Add waypoint', 'Draw']);
  });

  it('shows "Waiting for a GPS fix…" under it before a fix, and still runs it', async () => {
    const actions = await open({ addWaypointHint: 'Waiting for a GPS fix…' });
    expect(screen.getByText('Waiting for a GPS fix…')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Add waypoint'));
    expect(actions.onAddWaypoint).toHaveBeenCalledTimes(1);
  });

  it('has no sub-line once there is a fix', async () => {
    await open();
    expect(screen.queryByText('Waiting for a GPS fix…')).toBeNull();
  });
});
