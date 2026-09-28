import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { AttributionChip, CREDIT_OPEN_MS } from './AttributionChip';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('shows only an info button until tapped, then the credit for a few seconds', async () => {
  await render(
    <PaperProvider>
      <AttributionChip basemap="map" vector />
    </PaperProvider>,
  );
  expect(screen.queryByText(/OpenStreetMap/)).toBeNull();
  await fireEvent.press(screen.getByLabelText('Map data credits'));
  expect(screen.getByText('© OpenStreetMap · Protomaps')).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(CREDIT_OPEN_MS);
  });
  expect(screen.queryByText(/OpenStreetMap/)).toBeNull();
  expect(screen.getByLabelText('Map data credits')).toBeTruthy();
});
