/**
 * The team long-press card (#757: #744 option 2, the wrapping grid): every
 * action one tap away, five a row, in both themes; members and guests.
 */
import type { TeamView } from '@core/teamui/view';
import { FLOATING_CARD_GAP } from '@features/map/bottomLayers';
import { contrastRatio } from '@core/color/contrast';
import { useTeamStore } from '@state/teamStore';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
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

/** The grid's cells, in order. */
const rowIds = () =>
  screen
    .getByTestId('team-press-grid')
    .children.map((c) => (typeof c === 'string' ? c : (c.props.testID as string)));
const ALL = [
  'team-press-rally',
  'team-press-pin',
  'team-press-photo',
  'team-press-task',
  'team-press-notify',
  'team-press-waypoint',
  'team-press-navigate',
  'team-press-coordinates',
  'team-press-convert',
];

beforeEach(() => {
  mockPush.mockReset();
  mockSession.setRally.mockClear();
  mockSession.shareWaypoint.mockClear();
  onPointActions.mockClear();
  useTeamSheet.getState().open({ kind: 'press', at: AT });
  usePinDraft.setState({ at: null } as never);
});

describe('the team long-press card (#757: the wrapping grid)', () => {
  it.each(THEMES)(
    'nine cells, Meet here first, no More; labels on up to two lines (dark: %s)',
    async (dark) => {
      team('member');
      await render(card(dark));
      expect(rowIds()).toEqual(ALL);
      expect(screen.queryByTestId('team-press-more')).toBeNull();
      for (const label of ['Meet here', 'Pin', 'Photo', 'Task', 'Notify', 'Waypoint']) {
        expect(screen.getByText(label).props.numberOfLines).toBe(2);
        expect(screen.getByText(label).props.maxFontSizeMultiplier).toBe(1.15);
      }
      await fireEvent.press(screen.getByTestId('team-press-coordinates'));
      expect(onPointActions).toHaveBeenCalledWith(AT, 'coordinates');
    },
  );

  it.each(THEMES)('each disc shows on the card (dark: %s; QA: invisible in dark)', async (dark) => {
    team('member');
    await render(card(dark));
    const bg = StyleSheet.flatten(screen.getByTestId('team-press-card').props.style)
      .backgroundColor as string;
    for (const id of rowIds()) {
      const child = screen.getByTestId(id).children[0];
      if (child === undefined || typeof child === 'string') throw new Error(`${id}: no disc`);
      const disc = StyleSheet.flatten(child.props.style as ViewStyle);
      expect(disc.borderWidth).toBeGreaterThan(0);
      // A disc the eye finds: never melting into the card.
      const edge = id === 'team-press-rally' ? disc.backgroundColor : disc.borderColor;
      expect(contrastRatio(String(edge), bg)).toBeGreaterThanOrEqual(1.3);
    }
  });

  it.each([320, 360, 412])(
    'five a row on a %i dp phone: each cell a fifth, its disc and padding inside it',
    async (w) => {
      team('member');
      await render(card());
      const pad = StyleSheet.flatten(screen.getByTestId('team-press-card').props.style);
      const inner = w - 2 * FLOATING_CARD_GAP - 2 * Number(pad.paddingHorizontal);
      const grid = StyleSheet.flatten(screen.getByTestId('team-press-grid').props.style);
      expect(grid).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
      for (const id of rowIds()) {
        const st = StyleSheet.flatten(screen.getByTestId(id).props.style);
        expect(st.width).toBe('20%');
        const disc = StyleSheet.flatten(
          (screen.getByTestId(id).children[0] as unknown as { props: { style: ViewStyle } }).props
            .style,
        );
        expect(Number(disc.width)).toBeLessThanOrEqual(inner / 5);
      }
    },
  );

  it('floats like the point card: side gaps and a bottom gap, unless the dock floats (#757 review)', async () => {
    team('member');
    const r = await render(card());
    expect(StyleSheet.flatten(screen.getByTestId('team-press-card').props.style)).toMatchObject({
      marginHorizontal: FLOATING_CARD_GAP,
      marginBottom: FLOATING_CARD_GAP,
      borderRadius: 16,
    });
    await r.unmount();
    useTeamSheet.getState().open({ kind: 'press', at: AT });
    await render(
      wrap(
        <TeamSheetCard
          sheet={{ kind: 'press', at: AT }}
          here={null}
          onPointActions={onPointActions}
          floating
        />,
      ),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId('team-press-card').props.style).marginHorizontal,
    ).toBeUndefined();
  });

  it('Task opens New task at this spot; Notify opens its card; Waypoint shares it', async () => {
    team('member');
    const r = await render(card());
    await fireEvent.press(screen.getByTestId('team-press-task'));
    expect(mockPush).toHaveBeenCalledWith(`/team/task-new?ak=point&la=${AT[1]}&lo=${AT[0]}`);
    expect(useTeamSheet.getState().sheet).toBeNull();
    await r.unmount();

    useTeamSheet.getState().open({ kind: 'press', at: AT });
    const r2 = await render(card());
    await fireEvent.press(screen.getByTestId('team-press-notify'));
    expect(useTeamSheet.getState().sheet).toEqual({ kind: 'notify', at: AT });
    await r2.unmount();

    useTeamSheet.getState().open({ kind: 'press', at: AT });
    await render(card());
    await fireEvent.press(screen.getByTestId('team-press-waypoint'));
    expect(mockSession.shareWaypoint).toHaveBeenCalledWith({
      latitude: AT[1],
      longitude: AT[0],
      label: 'Waypoint',
    });
  });

  it('Meet here sets the rally point; Pin opens the composer', async () => {
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

  it('a guest: no Meet here, Task or Waypoint', async () => {
    team('guest');
    await render(card());
    expect(rowIds()).toEqual([
      'team-press-pin',
      'team-press-photo',
      'team-press-notify',
      'team-press-navigate',
      'team-press-coordinates',
      'team-press-convert',
    ]);
  });
});
