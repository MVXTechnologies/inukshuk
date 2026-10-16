/**
 * Activity, People and Recently deleted (#712, G10 mockups 7–9) over a mocked
 * live mockService, in light and dark: pinned lines act, People's sub-panel is a
 * manager's only, Restore reaches the mockService.
 */
import type { LiveFolder } from '@data/sync/liveFolders';
import { darkTheme, lightTheme } from '@ui/theme';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LiveActivityScreen } from './LiveActivityScreen';
import { LivePeopleScreen } from './LivePeopleScreen';
import { LiveTrashScreen } from './LiveTrashScreen';

const GID = 'g'.repeat(22);

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'g'.repeat(22) }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('@features/common/useScreenSheet', () => ({ useScreenSheet: jest.fn() }));

const mockService = {
  activity: jest.fn(),
  markSeen: jest.fn(),
  restore: jest.fn(() => null),
  restoreAll: jest.fn(() => null),
  remove: jest.fn(() => null),
  setRole: jest.fn(() => null),
  trash: jest.fn(),
  conflict: jest.fn(),
  keepVersion: jest.fn(() => null),
};
let mockFolders: LiveFolder[] = [];

jest.mock('./useLive', () => ({
  useLiveFolders: () => mockFolders,
  liveService: () => mockService,
  refreshLive: jest.fn(),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 360, height: 780 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function folder(over: Partial<LiveFolder> = {}): LiveFolder {
  return {
    groupId: GID,
    name: 'Gaspésie 2026',
    local: { kind: 'folder', id: 'gaspF' },
    joining: false,
    line: { text: 'Synced just now', tone: 'ok' },
    faces: [],
    people: [
      { id: 'me', name: 'You', detail: 'Owner', role: 'owner', isMe: true, pending: false },
      {
        id: 'ju',
        name: 'Julie Tremblay',
        detail: 'Can edit',
        role: 'member',
        isMe: false,
        pending: false,
      },
      {
        id: 'lea',
        name: 'Léa Pelletier',
        detail: 'Joins when Julie’s phone is online',
        isMe: false,
        pending: true,
      },
    ],
    peopleSummary: '2 can edit',
    myRole: 'owner',
    isOwner: true,
    canManage: true,
    subtitle: 'Live with Chic-Chocs crew · yours',
    toReview: 1,
    changesToday: 2,
    trashCount: 1,
    notes: new Map(),
    massDelete: [],
    ...over,
  };
}

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Share live screens (%s)', (_n, theme) => {
  const show = (ui: ReactElement) =>
    render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <PaperProvider theme={theme}>{ui}</PaperProvider>
      </SafeAreaProvider>,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    mockFolders = [folder()];
  });

  it('Activity: pinned lines act, days list the rest, and opening it marks it seen', async () => {
    mockService.activity.mockReturnValue({
      pinned: [
        {
          key: 'c',
          author: 'ju',
          parts: [
            { t: 'Julie', b: true },
            { t: ' and ' },
            { t: 'Noé', b: true },
            { t: ' both renamed ' },
            { t: 'Refuge', b: true },
          ],
          when: '5 h',
          review: { action: 'review', kind: 'lit', id: 'w1' },
        },
        {
          key: 'b',
          author: 'ju',
          parts: [{ t: 'Julie deleted Belvédère while you were editing it' }],
          when: '5 h',
          review: { action: 'restore', kind: 'lit', id: 'w2' },
        },
      ],
      days: [
        {
          label: 'Today',
          lines: [
            { key: 'x', author: 'ju', parts: [{ t: 'Julie renamed Lac loop' }], when: '2 h' },
          ],
        },
      ],
      people: ['ju'],
    });
    mockService.conflict.mockReturnValue({
      name: 'Refuge',
      conflicts: [
        {
          field: 'n',
          kept: { value: 'Refuge (fermé)', who: 'Noé', at: 1 },
          others: [{ value: 'Refuge, eau OK', who: 'Julie', at: 0 }],
        },
      ],
      merges: [{ who: 'Noé', fields: ['ic'] }],
    });
    await show(<LiveActivityScreen />);
    expect(mockService.markSeen).toHaveBeenCalledWith(GID);
    expect(screen.getByText('TODAY')).toBeTruthy();
    expect(screen.getAllByTestId('live-activity-pinned')).toHaveLength(2);
    await fireEvent.press(screen.getByTestId('live-activity-restore'));
    expect(mockService.restore).toHaveBeenCalledWith(GID, 'lit', 'w2');
    await fireEvent.press(screen.getByTestId('live-activity-review'));
    expect(screen.getByText('Refuge (fermé)')).toBeTruthy();
    expect(screen.getByText('KEPT')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('live-conflict-use'));
    expect(mockService.keepVersion).toHaveBeenCalledWith(GID, 'lit', 'w1', 'n', 'Refuge, eau OK');
  });

  it('Activity: a manager sees the mass-delete card', async () => {
    mockFolders = [
      folder({ massDelete: [{ author: 'ju', count: 34, from: 0, to: 1, records: ['lit:a'] }] }),
    ];
    mockService.activity.mockReturnValue({ pinned: [], days: [], people: [] });
    await show(<LiveActivityScreen />);
    expect(screen.getByText('Julie Tremblay deleted 34 items')).toBeTruthy();
    await fireEvent.press(screen.getByText('Restore all'));
    expect(mockService.restoreAll).toHaveBeenCalled();
  });

  it("People: a manager opens a person's sub-panel; others only read", async () => {
    await show(<LivePeopleScreen />);
    expect(screen.getByText('Joins when Julie’s phone is online')).toBeTruthy();
    await fireEvent.press(screen.getByText('Julie Tremblay'));
    await fireEvent.press(screen.getByTestId('live-person-view'));
    expect(mockService.setRole).toHaveBeenCalledWith(GID, 'ju', 'guest');
    await fireEvent.press(screen.getByText('Julie Tremblay'));
    await fireEvent.press(screen.getByTestId('live-person-remove'));
    expect(mockService.remove).toHaveBeenCalledWith(GID, 'ju');
  });

  it('People: a member cannot open anyone', async () => {
    mockFolders = [folder({ canManage: false, isOwner: false, myRole: 'member' })];
    await show(<LivePeopleScreen />);
    await fireEvent.press(screen.getByText('Julie Tremblay'));
    expect(screen.queryByTestId('live-person-sheet')).toBeNull();
  });

  it('Recently deleted: Restore', async () => {
    mockService.trash.mockReturnValue([
      {
        node: { kind: 'lit', id: 'w2', name: 'Belvédère du lac', fields: { t: 'wpt' } },
        since: { wall: Date.now() - 5 * 3_600_000, counter: 0, author: 'no' },
        expiresAt: 0,
        contents: 0,
        by: 'Noé',
      },
    ]);
    await show(<LiveTrashScreen />);
    expect(screen.getByText('Deleted by Noé · 5 h')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('live-trash-restore'));
    expect(mockService.restore).toHaveBeenCalledWith(GID, 'lit', 'w2');
  });
});
