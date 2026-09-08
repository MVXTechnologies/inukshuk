import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { CompassBadge } from './CompassBadge';

// The badge subscribes to the shared compass stream, which reaches for
// expo-location's heading watch. The needle-under-test here is the MAP one, so
// hold the device heading still at due north.
jest.mock('../useCompass', () => ({
  useCompass: () => ({ headingDeg: 0, accuracy: 3 }),
}));

async function renderBadge(props: { mapBearing?: number | null; onPress?: () => void } = {}) {
  await render(
    <PaperProvider>
      <CompassBadge {...props} />
    </PaperProvider>,
  );
}

/**
 * The rotation the red needle actually renders, as MapLibre-facing degrees.
 * `Animated.View` hands the host view an AnimatedInterpolation rather than a
 * string, so the assertion has to ask the node for its current value — which
 * is also the only way to prove the interpolation itself is right.
 */
function needleRotation(): string {
  const style = StyleSheet.flatten(screen.getByTestId('compass-north-needle').props.style) as {
    transform?: { rotate?: unknown }[];
  };
  const rotate = style.transform?.[0]?.rotate;
  if (typeof rotate === 'string') return rotate;
  return String((rotate as { __getValue: () => string }).__getValue());
}

describe('CompassBadge north needle', () => {
  it('draws the red needle pointing at north while the map is rotated', async () => {
    await renderBadge({ mapBearing: 45 });
    expect(screen.getByTestId('compass-north-needle')).toBeOnTheScreen();
    // Map turned 45° clockwise ⇒ north sits 45° counter-clockwise on screen.
    expect(needleRotation()).toBe('-45deg');
  });

  it('counter-rotates the other way for a negative bearing', async () => {
    await renderBadge({ mapBearing: -30 });
    expect(needleRotation()).toBe('30deg');
  });

  it('treats a bearing past 180° as the short way round', async () => {
    // 350° is a 10° counter-clockwise map rotation, not a 350° one.
    await renderBadge({ mapBearing: 350 });
    expect(needleRotation()).toBe('10deg');
  });

  it('labels the arrow tip with an N while rotated (#266)', async () => {
    await renderBadge({ mapBearing: 45 });
    expect(screen.getByText('N')).toBeOnTheScreen();
  });

  it('draws the north arrow after the heading needle, so it paints on top (#266)', async () => {
    await renderBadge({ mapBearing: 45 });
    const arrow = screen.getByTestId('compass-north-needle');
    const box = arrow.parent;
    const siblings = box?.children ?? [];
    expect(siblings[siblings.length - 1]).toBe(arrow);
  });

  it('hides the needle at north-up', async () => {
    await renderBadge({ mapBearing: 0 });
    expect(screen.queryByTestId('compass-north-needle')).toBeNull();
  });

  it('hides the needle for a sub-degree residue', async () => {
    await renderBadge({ mapBearing: 0.5 });
    expect(screen.queryByTestId('compass-north-needle')).toBeNull();
  });

  it('hides the needle when no bearing is supplied at all', async () => {
    await renderBadge();
    expect(screen.queryByTestId('compass-north-needle')).toBeNull();
  });
});

describe('CompassBadge accessibility', () => {
  it('says how far the map is rotated, and that tapping realigns it', async () => {
    await renderBadge({ mapBearing: 45, onPress: () => {} });
    expect(screen.getByLabelText('Map rotated 45°, realign north')).toBeOnTheScreen();
  });

  it('reports the rotation magnitude for a counter-clockwise bearing too', async () => {
    await renderBadge({ mapBearing: 350, onPress: () => {} });
    expect(screen.getByLabelText('Map rotated 10°, realign north')).toBeOnTheScreen();
  });

  it('is just the compass when the map is north-up', async () => {
    await renderBadge({ mapBearing: 0, onPress: () => {} });
    expect(screen.getByLabelText('Compass')).toBeOnTheScreen();
  });
});

describe('CompassBadge press', () => {
  it('still fires onPress while rotated', async () => {
    const onPress = jest.fn();
    await renderBadge({ mapBearing: 45, onPress });
    fireEvent.press(screen.getByLabelText('Map rotated 45°, realign north'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('still fires onPress at north-up', async () => {
    const onPress = jest.fn();
    await renderBadge({ mapBearing: 0, onPress });
    fireEvent.press(screen.getByLabelText('Compass'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
