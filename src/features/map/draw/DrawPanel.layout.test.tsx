/**
 * The drawing panel's bottom row at phone widths (#515 — "Save route gets
 * squished" on a 390 pt iPhone): Save never shrinks below its one-line
 * label; the Return chip collapses to icon + caret first; at 320 pt Save gets
 * its own full-width row. Layouts are mocked (no native layout in Jest).
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { DrawPanel, ReturnChip } from './DrawPanels';

/** Widths of the labels as the device would measure them (16/13 pt bold). */
const SAVE_LABEL_W = 82; // "Save route"
const CHIP_LABEL_W = 76; // "Back & forth"

async function mountAt(screenWidth: number, { chip = true } = {}) {
  await render(
    <PaperProvider>
      <DrawPanel
        title="Draw a route"
        stats={[]}
        canUndo
        canClear
        canSave
        saveLabel="Save route"
        onUndo={jest.fn()}
        onClear={jest.fn()}
        onSave={jest.fn()}
        onExit={jest.fn()}
        toggle={
          chip
            ? {
                label: 'Back & forth',
                render: (showLabel) => (
                  <ReturnChip
                    finish="backforth"
                    disabled={false}
                    open={false}
                    showLabel={showLabel}
                    onPress={jest.fn()}
                  />
                ),
              }
            : undefined
        }
      />
    </PaperProvider>,
  );
  const layout = (testID: string, width: number) =>
    fireEvent(screen.getByTestId(testID, { includeHiddenElements: true }), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width, height: 20 } },
    });
  await act(async () => {
    layout('measure-save', SAVE_LABEL_W);
    if (chip) layout('measure-chip', CHIP_LABEL_W);
    // The panel's 18 dp side padding.
    layout('draw-actions', screenWidth - 36);
  });
}

const saveMinWidth = () =>
  StyleSheet.flatten(screen.getByTestId('draw-save').props.style).minWidth as number;

describe('the Draw a route bottom row', () => {
  it('430 pt: one row, the chip with its label, Save at least its label wide', async () => {
    await mountAt(430);
    expect(screen.getByText('Back & forth')).toBeOnTheScreen();
    expect(screen.queryByTestId('draw-save-row')).toBeNull();
    expect(saveMinWidth()).toBeGreaterThanOrEqual(SAVE_LABEL_W);
    expect(screen.getByTestId('draw-save-label').props.numberOfLines).toBe(1);
  });

  it('375 pt: the chip collapses to icon + caret, keeping its spoken label; Save keeps its width', async () => {
    await mountAt(375);
    expect(screen.queryByText('Back & forth')).toBeNull();
    expect(screen.getByLabelText('Return: Back and forth')).toBeOnTheScreen();
    expect(screen.queryByTestId('draw-save-row')).toBeNull();
    expect(saveMinWidth()).toBeGreaterThanOrEqual(SAVE_LABEL_W);
  });

  it('320 pt: Save moves to its own full-width row instead of squeezing', async () => {
    await mountAt(320);
    const row = screen.getByTestId('draw-save-row');
    expect(row).toContainElement(screen.getByTestId('draw-save'));
    expect(screen.getByTestId('draw-save-label')).toHaveTextContent('Save route');
    expect(screen.getByTestId('draw-save-label').props.numberOfLines).toBe(1);
    // The icon row alone has room for the chip's label again.
    expect(screen.getByText('Back & forth')).toBeOnTheScreen();
  });

  it('the Area panel (no chip) keeps one row even at 320 pt', async () => {
    await mountAt(320, { chip: false });
    expect(screen.queryByTestId('draw-save-row')).toBeNull();
    expect(saveMinWidth()).toBeGreaterThanOrEqual(SAVE_LABEL_W);
  });
});
