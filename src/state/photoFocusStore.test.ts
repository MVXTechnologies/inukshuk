import { usePhotoFocusStore } from './photoFocusStore';

it('hands a focus request to its trail once', () => {
  const s = usePhotoFocusStore.getState();
  s.focus('t1', 'p1');
  expect(usePhotoFocusStore.getState().consume('t2')).toBeNull();
  expect(usePhotoFocusStore.getState().consume('t1')).toEqual({ trackId: 't1', photoId: 'p1' });
  expect(usePhotoFocusStore.getState().consume('t1')).toBeNull();
});
