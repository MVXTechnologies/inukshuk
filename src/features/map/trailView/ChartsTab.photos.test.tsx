import type { ChartSeries } from '@core/geo/track';
import type { TrackPhoto } from '@core/photos/model';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { ChartsTab } from './ChartsTab';

jest.mock('@data/storage', () => ({ resolveDocumentPath: (p: string) => `file:///doc/${p}` }));

const series: ChartSeries = {
  distances: [0, 2500, 5000, 7500, 10_000],
  totalM: 10_000,
  elevation: [500, 600, 700, 600, 500],
  speed: null,
  heartRate: null,
  stopMarks: [],
} as ChartSeries;

const photo = (id: string, extra: Partial<TrackPhoto> = {}) =>
  ({ id, thumb: `photos/t1/${id}.sq.jpg`, distanceM: 0, ...extra }) as TrackPhoto;
const photos = [
  { photo: photo('a', { caption: 'Lac des Cygnes appears', takenAt: 1 }), distanceM: 3200 },
  { photo: photo('b'), distanceM: 8000 },
];

async function mount(cursorDistanceM: number | null, onOpenPhoto = jest.fn()) {
  await render(
    <PaperProvider>
      <ChartsTab
        series={series}
        display="pace"
        cursorDistanceM={cursorDistanceM}
        onScrub={jest.fn()}
        photos={photos}
        onOpenPhoto={onOpenPhoto}
        onCursorPhoto={jest.fn()}
      />
    </PaperProvider>,
  );
  // Lay the plot out so the lane can place its circles.
  await fireEvent(screen.getByLabelText('Elevation chart'), 'layout', {
    nativeEvent: { layout: { width: 300, height: 120, x: 0, y: 0 } },
  });
}

it('draws a circle per photo on the lane', async () => {
  await mount(null);
  expect(screen.getByTestId('photo-lane')).toBeTruthy();
  expect(screen.getByLabelText('Photo: Lac des Cygnes appears')).toBeTruthy();
  expect(screen.queryByTestId('lane-caught-photo')).toBeNull();
});

it('names the photo the cursor caught, one tap from the viewer', async () => {
  const onOpenPhoto = jest.fn();
  await mount(3200, onOpenPhoto);
  expect(screen.getByText('Lac des Cygnes appears')).toBeTruthy();
  expect(screen.getByText('Photo 1 of 2 · drag to the next one')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Open photo 1 of 2'));
  expect(onOpenPhoto).toHaveBeenCalledWith('a');
});
