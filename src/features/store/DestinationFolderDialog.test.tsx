import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { DestinationFolderDialog } from './DestinationFolderDialog';

jest.mock('@data/diskSpace', () => ({ assessFreeSpaceForWrite: jest.fn() }));
jest.useFakeTimers();

/** Let Paper's dialog show / hide animations finish. */
const settle = () =>
  act(async () => {
    jest.advanceTimersByTime(1000);
  });

const FOLDERS = [{ id: 'f1', name: 'Gaspésie 2026', createdAt: 1 }];

async function open() {
  const onCreateFolder = jest.fn((_name: string) => 'new-id');
  const onConfirm = jest.fn();
  const onDismiss = jest.fn();
  await render(
    <PaperProvider>
      <DestinationFolderDialog
        visible
        itemTitle="Saint-Raymond — CanTopo 021L13"
        folders={FOLDERS}
        initialFolderId={null}
        onCreateFolder={onCreateFolder}
        onConfirm={onConfirm}
        onDismiss={onDismiss}
      />
    </PaperProvider>,
  );
  await settle();
  await fireEvent.press(screen.getByText('New folder…'));
  await settle();
  await fireEvent.changeText(screen.getByTestId('name-dialog-input'), 'Charlevoix');
  await fireEvent.press(screen.getByText('Create'));
  await settle();
  return { onCreateFolder, onConfirm, onDismiss };
}

describe('Add to Library › New folder… (QA 2.6.1)', () => {
  it('Cancel after naming a folder creates nothing', async () => {
    const { onCreateFolder, onConfirm, onDismiss } = await open();
    // Listed and chosen, but not created yet.
    expect(screen.getByText('Charlevoix')).toBeTruthy();
    expect(onCreateFolder).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCreateFolder).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Add creates the folder, then files the download in it', async () => {
    const { onCreateFolder, onConfirm } = await open();
    await fireEvent.press(screen.getByText('Add'));
    expect(onCreateFolder).toHaveBeenCalledWith('Charlevoix');
    expect(onConfirm).toHaveBeenCalledWith('new-id');
  });

  it('picking another folder after naming one creates nothing', async () => {
    const { onCreateFolder, onConfirm } = await open();
    await fireEvent.press(screen.getByText('Gaspésie 2026'));
    await fireEvent.press(screen.getByText('Add'));
    expect(onCreateFolder).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledWith('f1');
  });
});
