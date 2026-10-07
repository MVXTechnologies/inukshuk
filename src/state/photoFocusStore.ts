import { create } from 'zustand';

/**
 * The viewer's "Show on map" (#587): a one-shot request for the trail view
 * to ring a photo and centre its map on it. The trail view consumes it.
 */
export interface PhotoFocusRequest {
  trackId: string;
  photoId: string;
}

interface PhotoFocusState {
  request: PhotoFocusRequest | null;
  focus: (trackId: string, photoId: string) => void;
  /** Take the request for `trackId`, if there is one (it is cleared). */
  consume: (trackId: string) => PhotoFocusRequest | null;
}

export const usePhotoFocusStore = create<PhotoFocusState>((set, get) => ({
  request: null,
  focus: (trackId, photoId) => set({ request: { trackId, photoId } }),
  consume: (trackId) => {
    const { request } = get();
    if (!request || request.trackId !== trackId) return null;
    set({ request: null });
    return request;
  },
}));
