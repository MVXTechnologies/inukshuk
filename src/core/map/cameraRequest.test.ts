import { cameraRequestStep } from './cameraRequest';

describe('cameraRequestStep (#710: "On map" frames the trail)', () => {
  it('nothing pending: nothing to do', () => {
    expect(cameraRequestStep({ pending: false, ready: true, following: true })).toBe('idle');
  });

  it('waits while the map is hidden or not loaded, whatever follow says', () => {
    expect(cameraRequestStep({ pending: true, ready: false, following: true })).toBe('wait');
    expect(cameraRequestStep({ pending: true, ready: false, following: false })).toBe('wait');
  });

  it('turns follow mode off first, then runs', () => {
    expect(cameraRequestStep({ pending: true, ready: true, following: true })).toBe(
      'stopFollowing',
    );
    expect(cameraRequestStep({ pending: true, ready: true, following: false })).toBe('run');
  });
});
