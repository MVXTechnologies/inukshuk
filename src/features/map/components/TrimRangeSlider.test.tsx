import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { TrimRangeSlider } from './TrimRangeSlider';

/**
 * #308 (audit A25) — the trim slider announced itself as one "adjustable"
 * control but only moved through the PanResponder, so VoiceOver/TalkBack's
 * standard increment/decrement (dispatched as `onAccessibilityAction`) did
 * nothing. Each thumb is now its own named adjustable element with a value
 * and bounded increment/decrement.
 */
async function setup(props: { count: number; start: number; end: number }) {
  const onChange = jest.fn<void, [number, number]>();
  await render(
    <PaperProvider>
      <TrimRangeSlider {...props} onChange={onChange} />
    </PaperProvider>,
  );
  // Thumbs render once the rail has a width.
  await fireEvent(screen.getByTestId('trim-range-slider'), 'layout', {
    nativeEvent: { layout: { width: 322 } },
  });
  return onChange;
}

const a11yAction = (label: string, actionName: 'increment' | 'decrement') =>
  fireEvent(screen.getByLabelText(label), 'accessibilityAction', { nativeEvent: { actionName } });

describe('TrimRangeSlider screen-reader adjustment', () => {
  it('exposes each thumb as a named adjustable element with its value and bounds', async () => {
    await setup({ count: 10, start: 2, end: 7 });
    const start = screen.getByLabelText('Trim start');
    const end = screen.getByLabelText('Trim end');
    expect(start.props.accessibilityRole).toBe('adjustable');
    expect(end.props.accessibilityRole).toBe('adjustable');
    expect(start.props.accessibilityValue).toEqual({
      min: 0,
      max: 6,
      now: 2,
      text: 'Point 3 of 10',
    });
    expect(end.props.accessibilityValue).toEqual({
      min: 3,
      max: 9,
      now: 7,
      text: 'Point 8 of 10',
    });
    expect(start.props.accessibilityActions).toEqual([
      { name: 'increment' },
      { name: 'decrement' },
    ]);
  });

  it('moves the start thumb by increment/decrement without crossing the end thumb', async () => {
    const onChange = await setup({ count: 10, start: 2, end: 4 });
    await a11yAction('Trim start', 'increment');
    expect(onChange).toHaveBeenLastCalledWith(3, 4);
    await a11yAction('Trim start', 'decrement');
    expect(onChange).toHaveBeenLastCalledWith(1, 4);

    onChange.mockClear();
    const pinned = await setup({ count: 10, start: 3, end: 4 });
    await a11yAction('Trim start', 'increment'); // already at end - 1
    expect(pinned).not.toHaveBeenCalled();
  });

  it('moves the end thumb by increment/decrement within [start + 1, last]', async () => {
    const onChange = await setup({ count: 10, start: 2, end: 8 });
    await a11yAction('Trim end', 'increment');
    expect(onChange).toHaveBeenLastCalledWith(2, 9);
    await a11yAction('Trim end', 'decrement');
    expect(onChange).toHaveBeenLastCalledWith(2, 7);

    const atLast = await setup({ count: 10, start: 0, end: 9 });
    await a11yAction('Trim end', 'increment');
    expect(atLast).not.toHaveBeenCalled();
    const atFloor = await setup({ count: 10, start: 0, end: 1 });
    await a11yAction('Trim end', 'decrement');
    expect(atFloor).not.toHaveBeenCalled();
  });

  it('steps about 1% of a long track per action, clamped at the other thumb', async () => {
    const onChange = await setup({ count: 1000, start: 0, end: 999 });
    await a11yAction('Trim start', 'increment');
    expect(onChange).toHaveBeenLastCalledWith(10, 999);
    const nearEnd = await setup({ count: 1000, start: 995, end: 999 });
    await a11yAction('Trim start', 'increment');
    expect(nearEnd).toHaveBeenLastCalledWith(998, 999);
  });
});
