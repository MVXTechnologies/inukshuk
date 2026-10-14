import {
  LOW_ACCURACY_M,
  MOVE_PRECISION_HINT_MPP,
  moveBarHint,
  movedMessage,
  moveSummary,
  waypointCursorDropMessage,
  waypointDropMessage,
} from './waypointActions';

describe('one-tap drop message (#671)', () => {
  it('says nothing about accuracy at 10 m or better', () => {
    expect(waypointDropMessage('Waypoint 7', 4, 'metric')).toBe(
      'Waypoint 7 added at your position',
    );
    expect(waypointDropMessage('Waypoint 7', LOW_ACCURACY_M, 'metric')).toBe(
      'Waypoint 7 added at your position',
    );
    expect(waypointDropMessage('Waypoint 7', null, 'metric')).toBe(
      'Waypoint 7 added at your position',
    );
    expect(waypointDropMessage('Waypoint 7', NaN, 'metric')).toBe(
      'Waypoint 7 added at your position',
    );
  });

  it('warns past 10 m, in the user’s units', () => {
    expect(waypointDropMessage('Waypoint 7', 24.4, 'metric')).toBe(
      'Waypoint 7 added at your position · ±24 m, low accuracy',
    );
    expect(waypointDropMessage('Waypoint 7', 24.4, 'imperial')).toBe(
      'Waypoint 7 added at your position · ±80 ft, low accuracy',
    );
  });
});

describe('cursor drop message (#709)', () => {
  it('names the map centre, with no fix accuracy (it is not a fix)', () => {
    expect(waypointCursorDropMessage('Waypoint 8')).toBe('Waypoint 8 added at the map centre');
  });
});

describe('move summary (#676)', () => {
  const from = { latitude: 46.81394, longitude: -71.20761 };

  it('reports distance and direction', () => {
    // ~38 m north-east.
    const to = { latitude: 46.81418, longitude: -71.20726 };
    const s = moveSummary(from, to, 'metric');
    expect(Math.round(s.meters)).toBe(38);
    expect(s.text).toBe('38 m NE');
    // The zoom hint only while the map is coarse (≈ a 50 m scale bar or more).
    expect(moveBarHint(s, 2)).toBe('Moved 38 m NE · zoom in for precision');
    expect(moveBarHint(s, MOVE_PRECISION_HINT_MPP + 0.01)).toBe(
      'Moved 38 m NE · zoom in for precision',
    );
    expect(moveBarHint(s, MOVE_PRECISION_HINT_MPP)).toBe('Moved 38 m NE');
    expect(moveBarHint(s, 0.2)).toBe('Moved 38 m NE'); // a 20 m scale
    expect(moveBarHint(s)).toBe('Moved 38 m NE'); // scale unknown
    expect(movedMessage(s, 'metric')).toBe('Moved 38 m');
  });

  it('is "not moved" below half a metre', () => {
    const s = moveSummary(from, { latitude: 46.813942, longitude: -71.20761 }, 'metric');
    expect(s).toEqual({ meters: 0, text: null });
    expect(moveBarHint(s)).toBe('Pan the map to put the pin in its new place');
  });
});
