import { headingCameraMode } from './headingCameraMode';

describe('headingCameraMode', () => {
  it('heading-up off: the follow mode as asked, and no bearing from JS', () => {
    expect(headingCameraMode(false, 'default')).toEqual({
      trackUserLocation: 'default',
      jsBearing: false,
    });
    expect(headingCameraMode(false, undefined)).toEqual({
      trackUserLocation: undefined,
      jsBearing: false,
    });
  });

  it('heading-up while following: the native follow turns the map, JS never moves the camera', () => {
    // A JS camera move during a follow ends it on Android (2.6.1 QA: Locate
    // dropped to idle after one heading step).
    expect(headingCameraMode(true, 'default')).toEqual({
      trackUserLocation: 'heading',
      jsBearing: false,
    });
    expect(headingCameraMode(true, 'course')).toEqual({
      trackUserLocation: 'heading',
      jsBearing: false,
    });
  });

  it('heading-up without a follow: our display-rate heading turns the camera', () => {
    expect(headingCameraMode(true, undefined)).toEqual({
      trackUserLocation: undefined,
      jsBearing: true,
    });
  });
});
