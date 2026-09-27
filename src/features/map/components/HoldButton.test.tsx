import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, Text } from 'react-native';
import { HOLD_MS, HoldButton } from './HoldButton';

async function renderButton(onConfirm: () => void) {
  return render(
    <HoldButton
      size={56}
      onConfirm={onConfirm}
      accessibilityLabel="Stop recording"
      accessibilityHint="Press and hold to stop"
      trackColor="#D5CEBF"
      fillColor="#C62828"
      background="#EEE7D9"
    >
      <Text>■</Text>
    </HoldButton>,
  );
}

// Fake timers for the whole file: toggling them per test breaks the next
// test's render.
jest.useFakeTimers();

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('HoldButton', () => {
  // The ring is JS-driven feedback; outside act() its per-frame updates would
  // poison the renderer for the next test. The hold itself is a timer.
  beforeEach(() => {
    jest.spyOn(Animated, 'timing').mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
    } as unknown as Animated.CompositeAnimation);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing when released early', async () => {
    const onConfirm = jest.fn();
    await renderButton(onConfirm);
    const button = screen.getByLabelText('Stop recording');
    await fireEvent(button, 'pressIn');
    await wait(150);
    await fireEvent(button, 'pressOut');
    await wait(HOLD_MS);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms once the hold lasts the full duration', async () => {
    const onConfirm = jest.fn();
    await renderButton(onConfirm);
    await fireEvent(screen.getByLabelText('Stop recording'), 'pressIn');
    await wait(HOLD_MS + 150);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirms straight away for a screen reader activate', async () => {
    const onConfirm = jest.fn();
    await renderButton(onConfirm);
    await fireEvent(screen.getByLabelText('Stop recording'), 'accessibilityAction', {
      nativeEvent: { actionName: 'activate' },
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('says it needs a hold', async () => {
    await renderButton(jest.fn());
    expect(screen.getByLabelText('Stop recording').props.accessibilityHint).toBe(
      'Press and hold to stop',
    );
  });
});
