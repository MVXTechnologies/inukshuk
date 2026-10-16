/**
 * The team long-press card (#744, mockup 6 option 1): four round buttons
 * (Meet here, Message pin, Photo, More) that fit a 320 dp phone, the text row
 * under them, and More's sub-panel in place (Task, Notify, Shared waypoint)
 * with a way back. Both themes; members and guests.
 */
import type { TeamView } from '@core/teamui/view';
import { FLOATING_CARD_GAP } from '@features/map/bottomLayers';
import { useTeamStore } from '@state/teamStore';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { TeamSheetCard } from './TeamCards';
import { useTeamSheet } from './teamMode';
import { usePinDraft } from './TeamPinComposer';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, navigate: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));
const mockSession = {
  setRally: jest.fn(),
  shareWaypoint: jest.fn(() => null),
};
jest.mock('@data/team/appTeam', () => ({
  appTeamService: () => ({ active: mockSession }),
}));

const AT: [number, number] = [-71.230118, 46.812044];
const wrap = (children: ReactNode, dark = false) => (
  <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>
);
const THEMES = [false, true] as const;

function team(role: 'member' | 'guest') {
  useTeamStore.setState({
    view: {
      teamId: 't',
      name: 'Les Sentiers',
      me: 'me',
      active: true,
      members: [{ id: 'me', name: 'Marc', isMe: true, role, active: true }],
    } as unknown as TeamView,
    // The fake session has no snapshot to take.
    refresh: () => undefined,
  });
}

const onPointActions = jest.fn();
const card = (dark = false) =>
  wrap(
    <TeamSheetCard sheet={{ kind: 'press', at: AT }} here={null} onPointActions={onPointActions} />,
    dark,
  );

/** The round buttons in the card's row, in order. */
const rowIds = () =>
  screen
    .getByTestId('team-press-row')
    .children.map((c) => (typeof c === 'string' ? c : (c.props.testID as string)));

beforeEach(() => {
  mockPush.mockReset();
  mockSession.setRally.mockClear();
  mockSession.shareWaypoint.mockClear();
  onPointActions.mockClear();
  useTeamSheet.getState().open({ kind: 'press', at: AT });
  usePinDraft.setState({ at: null } as never);
});

describe('the team long-press card (#744)', () => {
  it.each(THEMES)(
    'four round buttons, Meet here first; the text row stays (dark: %s)',
    async (dark) => {
      team('member');
      await render(card(dark));
      expect(rowIds()).toEqual([
        'team-press-rally',
        'team-press-pin',
        'team-press-photo',
        'team-press-more',
      ]);
      expect(screen.getByText('Meet here')).toBeTruthy();
      expect(screen.getByText('Message pin')).toBeTruthy();
      for (const id of ['navigate', 'coordinates', 'convert'])
        expect(screen.getByTestId(`team-press-${id}`)).toBeTruthy();
      expect(screen.queryByTestId('team-press-task')).toBeNull();
      expect(screen.queryByTestId('team-press-notify')).toBeNull();
      await fireEvent.press(screen.getByTestId('team-press-coordinates'));
      expect(onPointActions).toHaveBeenCalledWith(AT, 'coordinates');
    },
  );

  it.each([320, 360, 412])(
    'the row fits a %i dp phone, card margins and padding included',
    async (w) => {
      team('member');
      await render(card());
      const pad = StyleSheet.flatten(screen.getByTestId('team-press-card').props.style);
      const inner = w - 2 * FLOATING_CARD_GAP - 2 * Number(pad.paddingHorizontal);
      const widths = rowIds().map((id) => {
        const st = StyleSheet.flatten(screen.getByTestId(id).props.style);
        expect(typeof st.width).toBe('number');
        return Number(st.width);
      });
      expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(inner);
    },
  );

  it.each(THEMES)(
    'More opens Task, Notify and Shared waypoint in place; back returns (dark: %s)',
    async (dark) => {
      team('member');
      await render(card(dark));
      await fireEvent.press(screen.getByTestId('team-press-more'));
      expect(screen.queryByTestId('team-press-card')).toBeNull();
      expect(screen.getByTestId('team-press-more-card')).toBeTruthy();
      expect(screen.getByText('More here')).toBeTruthy();
      for (const label of ['Task', 'Notify', 'Shared waypoint'])
        expect(screen.getByLabelText(label)).toBeTruthy();
      await fireEvent.press(screen.getByTestId('team-press-more-card-back'));
      expect(rowIds()).toHaveLength(4);
    },
  );

  it('More › Task opens New task at this spot; Notify opens its card; Shared waypoint shares it', async () => {
    team('member');
    const r = await render(card());
    await fireEvent.press(screen.getByTestId('team-press-more'));
    await fireEvent.press(screen.getByTestId('team-press-task'));
    expect(mockPush).toHaveBeenCalledWith(`/team/task-new?ak=point&la=${AT[1]}&lo=${AT[0]}`);
    expect(useTeamSheet.getState().sheet).toBeNull();
    await r.unmount();

    useTeamSheet.getState().open({ kind: 'press', at: AT });
    const r2 = await render(card());
    await fireEvent.press(screen.getByTestId('team-press-more'));
    await fireEvent.press(screen.getByTestId('team-press-notify'));
    expect(useTeamSheet.getState().sheet).toEqual({ kind: 'notify', at: AT });
    await r2.unmount();

    useTeamSheet.getState().open({ kind: 'press', at: AT });
    await render(card());
    await fireEvent.press(screen.getByTestId('team-press-more'));
    await fireEvent.press(screen.getByTestId('team-press-waypoint'));
    expect(mockSession.shareWaypoint).toHaveBeenCalledWith({
      latitude: AT[1],
      longitude: AT[0],
      label: 'Waypoint',
    });
  });

  it('Meet here sets the rally point; Message pin opens the composer', async () => {
    team('member');
    const r = await render(card());
    await fireEvent.press(screen.getByTestId('team-press-rally'));
    expect(mockSession.setRally).toHaveBeenCalledWith(AT[0], AT[1]);
    await r.unmount();
    useTeamSheet.getState().open({ kind: 'press', at: AT });
    await render(card());
    await fireEvent.press(screen.getByTestId('team-press-pin'));
    expect(usePinDraft.getState().at).toEqual(AT);
  });

  it('a guest: Message pin, Photo, More; More holds Notify only', async () => {
    team('guest');
    await render(card());
    expect(rowIds()).toEqual(['team-press-pin', 'team-press-photo', 'team-press-more']);
    await fireEvent.press(screen.getByTestId('team-press-more'));
    expect(screen.getByTestId('team-press-notify')).toBeTruthy();
    expect(screen.queryByTestId('team-press-task')).toBeNull();
    expect(screen.queryByTestId('team-press-waypoint')).toBeNull();
  });
});
