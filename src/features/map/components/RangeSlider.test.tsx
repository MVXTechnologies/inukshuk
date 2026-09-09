import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { RangeSlider } from './RangeSlider';

/**
 * #308 (audit A25) — the slope-window slider's thumbs carried labels but no
 * adjustable role, value or actions, so a screen reader could focus them and
 * still had no way to move them. Each thumb is now an adjustable element with
 * a bounded increment/decrement that commits straight to `onChange`.
 */
async function setup(props: Partial<React.ComponentProps<typeof RangeSlider>> = {}) {
  const onChange = jest.fn<void, [number, number]>();
  await render(
    <PaperProvider>
      <RangeSlider min={0} max={90} lo={5} hi={40} onChange={onChange} {...props} />
    </PaperProvider>,
  );
  return onChange;
}

const a11yAction = (label: string, actionName: 'increment' | 'decrement') =>
  fireEvent(screen.getByLabelText(label), 'accessibilityAction', { nativeEvent: { actionName } });

describe('RangeSlider screen-reader adjustment', () => {
  it('exposes both thumbs as named adjustable elements with values and bounds', async () => {
    await setup({ accessibilityLabel: 'Slope' });
    const lo = screen.getByLabelText('Slope minimum');
    const hi = screen.getByLabelText('Slope maximum');
    expect(lo.props.accessibilityRole).toBe('adjustable');
    expect(hi.props.accessibilityRole).toBe('adjustable');
    expect(lo.props.accessibilityValue).toEqual({ min: 0, max: 39, now: 5, text: '5°' });
    expect(hi.props.accessibilityValue).toEqual({ min: 6, max: 90, now: 40, text: '40°' });
    expect(lo.props.accessibilityActions).toEqual([{ name: 'increment' }, { name: 'decrement' }]);
  });

  it('falls back to Minimum / Maximum without a caller label', async () => {
    await setup();
    expect(screen.getByLabelText('Minimum')).toBeTruthy();
    expect(screen.getByLabelText('Maximum')).toBeTruthy();
  });

  it('increments and decrements each thumb by one unit, committing immediately', async () => {
    const onChange = await setup();
    await a11yAction('Minimum', 'increment');
    expect(onChange).toHaveBeenLastCalledWith(6, 40);
    await a11yAction('Minimum', 'decrement');
    expect(onChange).toHaveBeenLastCalledWith(4, 40);
    await a11yAction('Maximum', 'increment');
    expect(onChange).toHaveBeenLastCalledWith(5, 41);
    await a11yAction('Maximum', 'decrement');
    expect(onChange).toHaveBeenLastCalledWith(5, 39);
  });

  it('keeps the thumbs apart and inside [min, max]', async () => {
    const touching = await setup({ lo: 39, hi: 40 });
    await a11yAction('Minimum', 'increment');
    await a11yAction('Maximum', 'decrement');
    expect(touching).not.toHaveBeenCalled();

    const edges = await setup({ lo: 0, hi: 90 });
    await a11yAction('Minimum', 'decrement');
    await a11yAction('Maximum', 'increment');
    expect(edges).not.toHaveBeenCalled();
  });

  it('ignores actions while disabled', async () => {
    const onChange = await setup({ disabled: true });
    await a11yAction('Minimum', 'increment');
    expect(onChange).not.toHaveBeenCalled();
  });
});
