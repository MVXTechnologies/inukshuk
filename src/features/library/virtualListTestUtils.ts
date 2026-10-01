/**
 * Test helpers that make a FlatList virtualize under the test renderer
 * (#494). Nothing lays views out there, so a VirtualizedList never learns
 * how tall its cells are and never moves its render window; these report
 * the layouts a device would: the list's viewport, its content size, and
 * every mounted cell at a fixed height.
 */
import { act, fireEvent, type RenderResult } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { TestInstance } from 'test-renderer';

export interface ListGeometry {
  /** Visible height of the list. */
  viewportPx: number;
  /** Items in the list (content height = itemCount × cellPx). */
  itemCount: number;
  /** Height of every cell. */
  cellPx: number;
}

const isCell = (n: TestInstance): boolean =>
  typeof n.props.onLayout === 'function' && typeof n.props.onFocusCapture === 'function';

/**
 * Report every mounted cell's layout: cells stacked at a fixed `cellPx`, in
 * the order the list renders them, with its spacers (the stand-ins for
 * unmounted cells) taking their own height — so each cell lands at the
 * offset of its index, as on a device.
 */
export async function layoutCells(view: RenderResult, cellPx: number): Promise<void> {
  const first = view.container.queryAll((n) => isCell(n))[0];
  const content = first?.parent;
  if (!content) return;
  // Positions first (each layout event may re-render the list), then events.
  const placed: { cell: TestInstance; y: number }[] = [];
  let y = 0;
  for (const child of content.children) {
    if (typeof child === 'string') continue;
    if (isCell(child)) {
      placed.push({ cell: child, y });
      y += cellPx;
      continue;
    }
    const style = StyleSheet.flatten(child.props.style) as { height?: unknown } | undefined;
    if (typeof style?.height === 'number') y += style.height;
  }
  for (const { cell, y: top } of placed) {
    await fireEvent(cell, 'layout', {
      nativeEvent: { layout: { x: 0, y: top, width: 390, height: cellPx } },
    });
  }
}

/** Lay the list out (viewport + content size) and its mounted cells. */
export async function layoutList(
  view: RenderResult,
  list: TestInstance,
  { viewportPx, itemCount, cellPx }: ListGeometry,
): Promise<void> {
  await fireEvent(list, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 390, height: viewportPx } },
  });
  await fireEvent(list, 'contentSizeChange', 390, itemCount * cellPx);
  await layoutCells(view, cellPx);
}

/** Scroll to `y` the way a settled fling reports it, then lay out what mounted. */
export async function scrollListTo(
  view: RenderResult,
  list: TestInstance,
  y: number,
  { viewportPx, itemCount, cellPx }: ListGeometry,
): Promise<void> {
  await fireEvent.scroll(list, {
    nativeEvent: {
      contentOffset: { x: 0, y },
      layoutMeasurement: { width: 390, height: viewportPx },
      contentSize: { width: 390, height: itemCount * cellPx },
    },
  });
  // Let the list's batched window update land, then measure the new cells.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  await layoutCells(view, cellPx);
}
