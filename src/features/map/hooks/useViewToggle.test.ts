/**
 * The 3D/2D button (#720): the native terrain's pitch animation reports no
 * camera settle, so the button must answer the press itself and the screen
 * must get exactly ONE settled camera once the animation has run. Measured
 * in calls (animations started, camera reads, settles delivered).
 */
import type { RegionPayload } from '@core/map/regionPayload';
import { DEFAULT_3D_PITCH, VIEW_TOGGLE_MS } from '@core/terrain3d/viewToggle';
import { MAP_MAX_PITCH_DEG } from '@core/map/tiltRelief';
import { act, renderHook } from '@testing-library/react-native';
import {
  useViewToggle,
  VIEW_TOGGLE_SETTLE_MARGIN_MS,
  type ViewToggleOptions,
} from './useViewToggle';

const mockAnimatePitch = jest.fn(async (_tag: number, _deg: number, _ms: number) => undefined);
const mockModule: { current: { animatePitch?: typeof mockAnimatePitch } | null } = {
  current: { animatePitch: mockAnimatePitch },
};
jest.mock('@lib/nativeTerrain', () => ({ nativeTerrain: () => mockModule.current }));

jest.useFakeTimers();

const AFTER_ANIMATION = VIEW_TOGGLE_MS + VIEW_TOGGLE_SETTLE_MARGIN_MS;

const view = (pitch: number): RegionPayload => ({
  center: [-71.2, 46.8],
  zoom: 13,
  bearing: 0,
  pitch,
  bounds: [-71.3, 46.7, -71.1, 46.9],
  userInteraction: false,
  animated: false,
});

function setup(over: Partial<ViewToggleOptions> = {}) {
  const setStop = jest.fn(async () => undefined);
  const camera = { current: { setStop } } as unknown as ViewToggleOptions['cameraRef'];
  let cameraPitch = 0;
  const readView = jest.fn(async () => view(cameraPitch));
  const onSettled = jest.fn((_v: RegionPayload) => undefined);
  const opts: ViewToggleOptions = {
    cameraRef: camera,
    viewTag: 7,
    terrainActive: true,
    readView,
    onSettled,
    ...over,
  };
  return {
    opts,
    setStop,
    readView,
    onSettled,
    setCameraPitch: (p: number) => {
      cameraPitch = p;
    },
  };
}

beforeEach(() => {
  mockAnimatePitch.mockClear();
  mockModule.current = { animatePitch: mockAnimatePitch };
});

describe('useViewToggle', () => {
  it('2D → 3D natively: the button flips at the press, and the screen gets ONE settle after the animation', async () => {
    const s = setup();
    const { result } = await renderHook(() => useViewToggle(s.opts));
    expect(result.current.is3d).toBe(false);

    await act(async () => result.current.onPress());
    expect(mockAnimatePitch).toHaveBeenCalledTimes(1);
    expect(mockAnimatePitch).toHaveBeenCalledWith(7, DEFAULT_3D_PITCH, VIEW_TOGGLE_MS);
    // No settle from MapLibre: the button already offers 2D.
    expect(result.current.is3d).toBe(true);
    expect(s.readView).not.toHaveBeenCalled();

    s.setCameraPitch(DEFAULT_3D_PITCH);
    await act(async () => {
      jest.advanceTimersByTime(AFTER_ANIMATION);
    });
    expect(s.readView).toHaveBeenCalledTimes(1);
    expect(s.onSettled).toHaveBeenCalledTimes(1);
    expect(s.onSettled.mock.calls[0]?.[0].pitch).toBe(DEFAULT_3D_PITCH);
    // Nothing else is scheduled.
    await act(async () => {
      jest.advanceTimersByTime(10 * AFTER_ANIMATION);
    });
    expect(s.readView).toHaveBeenCalledTimes(1);
    expect(s.setStop).not.toHaveBeenCalled();
  });

  it('a second press goes back to 2D (it never repeats the first direction), then to the remembered tilt', async () => {
    const s = setup();
    const { result } = await renderHook(() => useViewToggle(s.opts));
    await act(async () => result.current.onPress());
    await act(async () => {
      jest.advanceTimersByTime(AFTER_ANIMATION);
    });
    // The person tilts further by hand; MapLibre reports that settle.
    await act(async () => result.current.onSettledPitch(72));
    await act(async () => result.current.onPress());
    expect(mockAnimatePitch).toHaveBeenLastCalledWith(7, 0, VIEW_TOGGLE_MS);
    expect(result.current.is3d).toBe(false);
    await act(async () => result.current.onPress());
    expect(mockAnimatePitch).toHaveBeenLastCalledWith(7, 72, VIEW_TOGGLE_MS);
    expect(mockAnimatePitch).toHaveBeenCalledTimes(3);
  });

  it('quick presses read the camera once, after the last animation', async () => {
    const s = setup();
    const { result } = await renderHook(() => useViewToggle(s.opts));
    await act(async () => result.current.onPress());
    await act(async () => {
      jest.advanceTimersByTime(VIEW_TOGGLE_MS / 2);
    });
    await act(async () => result.current.onPress());
    await act(async () => {
      jest.advanceTimersByTime(AFTER_ANIMATION);
    });
    expect(mockAnimatePitch).toHaveBeenCalledTimes(2);
    expect(s.readView).toHaveBeenCalledTimes(1);
    expect(s.onSettled).toHaveBeenCalledTimes(1);
  });

  it('the pitch ceiling: a remembered 75° tilt comes back only while the native terrain draws', async () => {
    const back = async (terrainActive: boolean) => {
      mockAnimatePitch.mockClear();
      const s = setup({ terrainActive });
      const { result } = await renderHook(() => useViewToggle(s.opts));
      await act(async () => result.current.onSettledPitch(75));
      await act(async () => result.current.onPress()); // → 2D, remembers 75
      await act(async () => result.current.onPress()); // → back to 3D
      return mockAnimatePitch.mock.calls.at(-1)?.[1];
    };
    expect(await back(true)).toBe(75);
    expect(await back(false)).toBe(MAP_MAX_PITCH_DEG);
  });

  it('without the native terrain: MapLibre animates (and reports its own settle), no read-back', async () => {
    mockModule.current = null;
    const s = setup({ viewTag: null, terrainActive: false });
    const { result } = await renderHook(() => useViewToggle(s.opts));
    await act(async () => result.current.onPress());
    expect(s.setStop).toHaveBeenCalledTimes(1);
    expect(s.setStop).toHaveBeenCalledWith({
      pitch: DEFAULT_3D_PITCH,
      duration: VIEW_TOGGLE_MS,
      easing: 'ease',
    });
    await act(async () => {
      jest.advanceTimersByTime(10 * AFTER_ANIMATION);
    });
    expect(s.readView).not.toHaveBeenCalled();
    expect(s.onSettled).not.toHaveBeenCalled();
  });

  it('an unusable or failed read settles nothing; unmounting cancels the read', async () => {
    const s = setup();
    s.readView.mockResolvedValueOnce(null as unknown as RegionPayload);
    const { result, unmount } = await renderHook(() => useViewToggle(s.opts));
    await act(async () => result.current.onPress());
    await act(async () => {
      jest.advanceTimersByTime(AFTER_ANIMATION);
    });
    expect(s.onSettled).not.toHaveBeenCalled();

    s.readView.mockRejectedValueOnce(new Error('torn down'));
    await act(async () => result.current.onPress());
    await act(async () => {
      jest.advanceTimersByTime(AFTER_ANIMATION);
    });
    expect(s.onSettled).not.toHaveBeenCalled();

    await act(async () => result.current.onPress());
    await unmount();
    await act(async () => {
      jest.advanceTimersByTime(AFTER_ANIMATION);
    });
    expect(s.readView).toHaveBeenCalledTimes(2);
  });
});
