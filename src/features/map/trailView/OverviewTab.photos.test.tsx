import type { PhotoOnAxis } from '@core/photos/axis';
import type { TrackPhoto } from '@core/photos/model';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { OverviewTab } from './OverviewTab';

jest.mock('@data/storage', () => ({ resolveDocumentPath: (p: string) => `file:///doc/${p}` }));

const photo = (id: string, extra: Partial<TrackPhoto> = {}): TrackPhoto =>
  ({
    id,
    trackId: 't1',
    distanceM: 0,
    lngLat: [0, 0],
    placement: 'time',
    file: `photos/t1/${id}.jpg`,
    thumb: `photos/t1/${id}.sq.jpg`,
    sprite: `photos/t1/${id}.map.png`,
    width: 1,
    height: 1,
    bytes: 1,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }) as TrackPhoto;

const along = (p: TrackPhoto, distanceM: number): PhotoOnAxis => ({ photo: p, distanceM });

function mount(props: Partial<Parameters<typeof OverviewTab>[0]> = {}) {
  return render(
    <PaperProvider>
      <OverviewTab
        tiles={[]}
        series={null}
        cursorDistanceM={null}
        onScrub={jest.fn()}
        marks={[]}
        onJump={jest.fn()}
        notes={[{ id: 'n1', distanceM: 1500, text: 'Water', createdAt: 1 }]}
        onOpenNote={jest.fn()}
        {...props}
      />
    </PaperProvider>,
  );
}

it('lists photos and notes in trail order, with an Add photos button', async () => {
  const onOpenPhoto = jest.fn();
  const onAddPhotos = jest.fn();
  await mount({
    photos: [
      along(photo('a', { caption: 'Lichen glade' }), 120),
      along(photo('b', { hidden: true }), 3200),
      // A note photo rides its note card, not a second card.
      along(photo('note:n1', { placement: 'manual' }), 1500),
    ],
    onOpenPhoto,
    onAddPhotos,
  });
  expect(screen.getByText('Photos and waypoints · 3')).toBeTruthy();
  const cards = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel as string);
  expect(cards.filter((l) => /^(Photo|Note) /.test(l))).toEqual([
    'Photo 1 of 2: Lichen glade',
    'Note 1: Water',
    'Photo 2 of 2: Photo 2 (hidden from the map)',
  ]);
  await fireEvent.press(screen.getByLabelText('Photo 1 of 2: Lichen glade'));
  expect(onOpenPhoto).toHaveBeenCalledWith('a');
  await fireEvent.press(screen.getByLabelText('Add photos'));
  expect(onAddPhotos).toHaveBeenCalled();
});

it('hides Add photos and says why when photos cannot be changed', async () => {
  await mount({ photos: [], photoNotice: 'These photos were saved by a newer version.' });
  expect(screen.queryByLabelText('Add photos')).toBeNull();
  expect(screen.getByText('These photos were saved by a newer version.')).toBeTruthy();
});
