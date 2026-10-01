import type { Area } from '@core/models';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { HOLD_MS } from '../components/HoldButton';
import { AreaCard } from './AreaCard';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const AREA: Area = {
  id: 'a1',
  name: 'Blueberry slope',
  ring: [
    [-71.2, 46.8],
    [-71.19, 46.8],
    [-71.19, 46.81],
    [-71.2, 46.81],
  ],
  color: '#2563EB',
  note: 'Lots of wild blueberries mid-August.',
  photoUris: ['file:///doc/photos/a.jpg'],
  tags: ['Berries', 'Private notes'],
  createdAt: 1,
};

async function setup(area: Area = AREA, units: 'metric' | 'imperial' = 'metric') {
  const handlers = {
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    onClose: jest.fn(),
    onAddPhoto: jest.fn(),
    onShare: jest.fn(),
  };
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider>
        <AreaCard area={area} units={units} {...handlers} />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  return handlers;
}

jest.useFakeTimers();

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('AreaCard (#503)', () => {
  beforeEach(() => {
    jest.spyOn(Animated, 'timing').mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
    } as unknown as Animated.CompositeAnimation);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the name, size, perimeter, note, photo and tags at a glance', async () => {
    await setup();
    expect(screen.getByText('Blueberry slope')).toBeOnTheScreen();
    expect(screen.getByTestId('area-card-summary')).toHaveTextContent(
      /^Area · [\d.]+ km² · perimeter [\d.]+ km$/,
    );
    expect(screen.getByTestId('area-note')).toHaveTextContent(
      'Lots of wild blueberries mid-August.',
    );
    expect(screen.getByLabelText('View photo')).toBeOnTheScreen();
    expect(screen.getByText('Berries')).toBeOnTheScreen();
    expect(screen.getByText('Private notes')).toBeOnTheScreen();
  });

  it('reads the size in the unit setting', async () => {
    await setup(AREA, 'imperial');
    expect(screen.getByTestId('area-card-summary')).toHaveTextContent(/ ac · perimeter .* mi$/);
  });

  it('Edit, Close, + Photo and Share fire their handlers', async () => {
    const h = await setup();
    await fireEvent.press(screen.getByLabelText('Edit area'));
    await fireEvent.press(screen.getByLabelText('Close area'));
    await fireEvent.press(screen.getByLabelText('Add photo to area'));
    await fireEvent.press(screen.getByText('Share GeoJSON'));
    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onAddPhoto).toHaveBeenCalledTimes(1);
    expect(h.onShare).toHaveBeenCalledTimes(1);
  });

  it('deletes only after a full hold', async () => {
    const h = await setup();
    const del = screen.getByLabelText('Delete area');
    await fireEvent(del, 'pressIn');
    await wait(200);
    await fireEvent(del, 'pressOut');
    await wait(HOLD_MS);
    expect(h.onDelete).not.toHaveBeenCalled();
    await fireEvent(del, 'pressIn');
    await wait(HOLD_MS + 100);
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it('an area with nothing attached still offers + Photo, and no tag row', async () => {
    await setup({ ...AREA, note: undefined, photoUris: undefined, tags: undefined });
    expect(screen.queryByTestId('area-note')).toBeNull();
    expect(screen.queryByLabelText('View photo')).toBeNull();
    expect(screen.getByLabelText('Add photo to area')).toBeOnTheScreen();
    expect(screen.queryByText('Berries')).toBeNull();
  });
});
