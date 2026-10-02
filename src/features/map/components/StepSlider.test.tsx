import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { StepSlider, stopAt } from './StepSlider';

const LABELS = ['Off', '25 %', '50 %', '75 %', '100 %'] as const;
const WIDTH = 200; // 50 dp between stops

async function setup(props: Partial<React.ComponentProps<typeof StepSlider>> = {}) {
  const onChange = jest.fn<void, [number]>();
  await render(
    <PaperProvider>
      <StepSlider
        labels={LABELS}
        value={0}
        onChange={onChange}
        width={WIDTH}
        accessibilityLabel="See-through white"
        {...props}
      />
    </PaperProvider>,
  );
  return onChange;
}

const slider = () => screen.getByLabelText('See-through white');

const a11yAction = (actionName: 'increment' | 'decrement') =>
  act(async () => {
    fireEvent(slider(), 'accessibilityAction', { nativeEvent: { actionName } });
  });

/** A one-finger touch history at page-x `x` (previously at `prevX`), time `t`. */
function history(x: number, prevX: number, t: number) {
  const touch = {
    touchActive: true,
    startPageX: prevX,
    startPageY: 0,
    startTimeStamp: 0,
    currentPageX: x,
    currentPageY: 0,
    currentTimeStamp: t,
    previousPageX: prevX,
    previousPageY: 0,
    previousTimeStamp: t - 1,
  };
  return {
    numberActiveTouches: 1,
    indexOfSingleActiveTouch: 0,
    mostRecentTimeStamp: t,
    touchBank: [touch],
  };
}

const touch = (name: string, locationX: number, x: number, prevX: number, t: number) =>
  act(async () => {
    fireEvent(slider(), name, { nativeEvent: { locationX }, touchHistory: history(x, prevX, t) });
  });

describe('stopAt', () => {
  it('snaps a track position to the nearest stop', () => {
    expect(stopAt(0, 200, 5)).toBe(0);
    expect(stopAt(24, 200, 5)).toBe(0);
    expect(stopAt(26, 200, 5)).toBe(1);
    expect(stopAt(100, 200, 5)).toBe(2);
    expect(stopAt(200, 200, 5)).toBe(4);
  });

  it('clamps past the ends and survives degenerate input', () => {
    expect(stopAt(-40, 200, 5)).toBe(0);
    expect(stopAt(500, 200, 5)).toBe(4);
    expect(stopAt(50, 0, 5)).toBe(0);
    expect(stopAt(50, 200, 1)).toBe(0);
    expect(stopAt(Number.NaN, 200, 5)).toBe(0);
  });
});

describe('StepSlider', () => {
  it('is one adjustable element valued with the stop label', async () => {
    await setup({ value: 2 });
    expect(slider().props.accessibilityRole).toBe('adjustable');
    expect(slider().props.accessibilityValue).toEqual({ min: 0, max: 4, now: 2, text: '50 %' });
    expect(slider().props.accessibilityActions).toEqual([
      { name: 'increment' },
      { name: 'decrement' },
    ]);
    expect(screen.getByText('50 %')).toBeTruthy();
  });

  it('increments and decrements one stop, committing at once', async () => {
    const onChange = await setup({ value: 2 });
    await a11yAction('increment');
    expect(onChange).toHaveBeenLastCalledWith(3);
    await a11yAction('decrement');
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('stays inside the stops', async () => {
    const atEnd = await setup({ value: 4 });
    await a11yAction('increment');
    expect(atEnd).not.toHaveBeenCalled();
    const atStart = await setup({ value: 0 });
    await a11yAction('decrement');
    expect(atStart).not.toHaveBeenCalled();
  });

  it('jumps to the stop under a tap', async () => {
    const onChange = await setup({ value: 0 });
    await touch('responderGrant', 148, 148, 148, 1);
    // The value label follows the finger before the lift commits.
    expect(screen.getByText('75 %')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    await touch('responderRelease', 148, 148, 148, 2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(3);
  });

  it('follows a drag stop by stop and commits the stop under the lift', async () => {
    const onChange = await setup({ value: 1 });
    await touch('responderGrant', 50, 300, 300, 1);
    await touch('responderMove', 50, 400, 300, 2); // +100 dp → 150 → stop 3
    expect(screen.getByText('75 %')).toBeTruthy();
    await touch('responderMove', 50, 500, 400, 3); // +200 dp → past the end → stop 4
    expect(slider().props.accessibilityValue).toMatchObject({ now: 4, text: '100 %' });
    await touch('responderRelease', 50, 500, 500, 4);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(4);
  });

  it('ignores touches and actions while disabled', async () => {
    const onChange = await setup({ value: 1, disabled: true });
    expect(slider().props.accessibilityState).toMatchObject({ disabled: true });
    await a11yAction('increment');
    expect(onChange).not.toHaveBeenCalled();
  });
});
