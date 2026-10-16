/**
 * Share live's screens (#712, G10 mockups): each renders in light and dark,
 * the choices reach their callbacks, and owner-only / manager-only rows
 * appear only for them (sub-panels, never greyed-out rows).
 */
import type { LiveFolder } from '@data/sync/liveFolders';
import { darkTheme, lightTheme } from '@ui/theme';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SectionHeader } from '../components/LibraryChrome';
import { WaypointRow } from '../components/LibraryRows';
import { JoiningFolders } from './JoiningFolders';
import { LeaveDialog, SharedFolderSheet, StopDialog } from './SharedFolderSheet';
import { ShareLiveSheet } from './ShareLiveSheet';

jest.mock('@features/common/useScreenSheet', () => ({ useScreenSheet: jest.fn() }));

const METRICS = {
  frame: { x: 0, y: 0, width: 360, height: 780 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const THEMES = [
  ['light', lightTheme],
  ['dark', darkTheme],
] as const;

async function show(ui: ReactElement, theme: (typeof THEMES)[number][1]) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider theme={theme}>{ui}</PaperProvider>
    </SafeAreaProvider>,
  );
}

function folder(over: Partial<LiveFolder> = {}): LiveFolder {
  return {
    groupId: 'g'.repeat(22),
    name: 'Gaspésie 2026',
    local: { kind: 'folder', id: 'gaspF' },
    joining: false,
    line: { text: 'Synced 2 min ago', tone: 'ok' },
    faces: [
      { id: 'j', initials: 'JT', color: '#3F8FD8' },
      { id: 'n', initials: 'NG', color: '#D9A520' },
    ],
    people: [],
    peopleSummary: '4 can edit · 2 can view',
    myRole: 'owner',
    isOwner: true,
    canManage: true,
    subtitle: 'Live with Chic-Chocs crew · yours',
    toReview: 1,
    changesToday: 5,
    trashCount: 2,
    notes: new Map(),
    massDelete: [],
    ...over,
  };
}

describe.each(THEMES)('Share live screens (%s)', (_name, theme) => {
  it('Share live: a team by default, Edit by default, Only view on request', async () => {
    const onStart = jest.fn();
    await show(
      <ShareLiveSheet
        visible
        focused
        subtitle="Gaspésie 2026 · and anything added later"
        teams={[
          { id: 't1', name: 'Chic-Chocs crew', people: 6 },
          { id: 't2', name: 'Famille', people: 3 },
        ]}
        busy={false}
        onStart={onStart}
        onClose={jest.fn()}
      />,
      theme,
    );
    expect(screen.getByText('Team · 6 people · and who joins later')).toBeTruthy();
    expect(screen.queryByTestId('share-live-new-group')).toBeNull();
    await fireEvent.press(screen.getByTestId('share-live-start'));
    expect(onStart).toHaveBeenLastCalledWith({ with: { team: 't1' }, canEdit: true });
    await fireEvent.press(screen.getByTestId('share-live-team-t2'));
    await fireEvent.press(screen.getByTestId('share-live-role-view'));
    await fireEvent.press(screen.getByTestId('share-live-start'));
    expect(onStart).toHaveBeenLastCalledWith({ with: { team: 't2' }, canEdit: false });
  });

  it("the folder's own sheet: Stop sharing for its owner, Leave for others", async () => {
    const onStop = jest.fn();
    const onLeave = jest.fn();
    const props = {
      focused: true,
      onPeople: jest.fn(),
      onActivity: jest.fn(),
      onTrash: jest.fn(),
      onStop,
      onLeave,
      onClose: jest.fn(),
    };
    const view = await show(<SharedFolderSheet folder={folder()} {...props} />, theme);
    expect(screen.getByText('1 to review')).toBeTruthy();
    expect(screen.getByText('5 changes today')).toBeTruthy();
    expect(screen.getByText('2 items')).toBeTruthy();
    expect(screen.queryByTestId('shared-sheet-leave')).toBeNull();
    await fireEvent.press(screen.getByTestId('shared-sheet-stop'));
    expect(onStop).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('shared-sheet-activity'));
    expect(props.onActivity).toHaveBeenCalled();
    await view.rerender(
      <SafeAreaProvider initialMetrics={METRICS}>
        <PaperProvider theme={theme}>
          <SharedFolderSheet
            folder={folder({ isOwner: false, canManage: false, toReview: 0 })}
            {...props}
          />
        </PaperProvider>
      </SafeAreaProvider>,
    );
    expect(screen.queryByTestId('shared-sheet-stop')).toBeNull();
    expect(screen.queryByTestId('shared-sheet-copy')).toBeNull();
    expect(screen.queryByText('1 to review')).toBeNull();
    await fireEvent.press(screen.getByTestId('shared-sheet-leave'));
    expect(onLeave).toHaveBeenCalled();
  });

  it('Leave keeps a copy by default; Remove it on request', async () => {
    const onLeave = jest.fn();
    await show(
      <LeaveDialog name="Gaspésie 2026" items={6} onLeave={onLeave} onCancel={jest.fn()} />,
      theme,
    );
    expect(screen.getByText('Leave Gaspésie 2026?')).toBeTruthy();
    expect(screen.getByText('6 items')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('shared-leave-dialog-confirm'));
    expect(onLeave).toHaveBeenLastCalledWith(true);
    await fireEvent.press(screen.getByTestId('shared-leave-remove'));
    await fireEvent.press(screen.getByTestId('shared-leave-dialog-confirm'));
    expect(onLeave).toHaveBeenLastCalledWith(false);
  });

  it('Stop sharing asks once', async () => {
    const onStop = jest.fn();
    await show(<StopDialog name="Gaspésie 2026" onStop={onStop} onCancel={jest.fn()} />, theme);
    await fireEvent.press(screen.getByTestId('shared-stop-dialog-confirm'));
    expect(onStop).toHaveBeenCalled();
  });

  it("a shared folder's header: its line, faces and ⋮; a joining folder's spinner line", async () => {
    const onMenu = jest.fn();
    await show(
      <>
        <SectionHeader
          title="Gaspésie 2026"
          count="(6)"
          collapsed={false}
          onToggle={jest.fn()}
          live={{ line: 'Synced 2 min ago', tone: 'ok', faces: folder().faces, onMenu }}
        />
        <JoiningFolders
          folders={[
            folder({
              groupId: 'h'.repeat(22),
              name: 'Charlevoix',
              joining: true,
              line: { text: 'Joining · from Julie', tone: 'join' },
            }),
          ]}
        />
      </>,
      theme,
    );
    expect(screen.getByText('Synced 2 min ago')).toBeTruthy();
    expect(screen.getAllByText('JT', { includeHiddenElements: true })).toHaveLength(2);
    expect(screen.getByText('Joining · from Julie')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('library-shared-menu'));
    expect(onMenu).toHaveBeenCalled();
  });

  it('the folder sheet offers Send a copy when it can', async () => {
    const onSendCopy = jest.fn();
    await show(
      <SharedFolderSheet
        folder={folder()}
        focused
        onPeople={jest.fn()}
        onActivity={jest.fn()}
        onTrash={jest.fn()}
        onSendCopy={onSendCopy}
        onStop={jest.fn()}
        onLeave={jest.fn()}
        onClose={jest.fn()}
      />,
      theme,
    );
    await fireEvent.press(screen.getByTestId('shared-sheet-copy'));
    expect(onSendCopy).toHaveBeenCalled();
  });

  it('a row not sent yet shows the clock before its caption', async () => {
    await show(
      <WaypointRow
        name="Refuge"
        detail="Waypoint"
        caption="Not sent yet · renamed by you"
        captionIcon="clock-outline"
        accessibilityLabel="Refuge"
        onPress={jest.fn()}
        onLongPress={jest.fn()}
        testID="row"
      />,
      theme,
    );
    expect(screen.getByText('Not sent yet · renamed by you')).toBeTruthy();
  });
});
