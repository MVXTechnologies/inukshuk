import { DEFAULT_3D_PITCH, is3dPitch, toggleView, VIEW_2D_MAX_PITCH } from './viewToggle';

describe('3D/2D toggle', () => {
  it('flattens a tilted view and remembers the tilt', () => {
    expect(toggleView(72, null)).toEqual({ pitch: 0, remember: 72 });
  });
  it('goes back to the remembered tilt', () => {
    expect(toggleView(0, 72)).toEqual({ pitch: 72, remember: null });
  });
  it('uses a default tilt with nothing (or nothing 3D) to return to', () => {
    expect(toggleView(0, null).pitch).toBe(DEFAULT_3D_PITCH);
    expect(toggleView(3, 5).pitch).toBe(DEFAULT_3D_PITCH);
  });
  it('respects the pitch ceiling', () => {
    expect(toggleView(0, 80, 60).pitch).toBe(60);
  });
  it('reads a nearly flat map as 2D', () => {
    expect(is3dPitch(VIEW_2D_MAX_PITCH)).toBe(false);
    expect(is3dPitch(VIEW_2D_MAX_PITCH + 1)).toBe(true);
  });
});
