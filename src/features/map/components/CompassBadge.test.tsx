import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { CompassBadge } from './CompassBadge';

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

  // The revamp's puck (decision 1) shows only the map's orientation — no
  // device-heading needle to be told apart from — so the needle is always
  // drawn and simply points up at north-up.
  it('points straight up at north-up', async () => {
    await renderBadge({ mapBearing: 0 });
    expect(screen.getByTestId('compass-north-needle')).toBeOnTheScreen();
    expect(needleRotation()).toBe('0deg');
  });

  it('points up when no bearing is supplied at all', async () => {
    await renderBadge();
    expect(needleRotation()).toBe('0deg');
  });

  it('calls a sub-degree residue north-up in its label', async () => {
    await renderBadge({ mapBearing: 0.5 });
    expect(needleRotation()).toBe('-0.5deg');
    expect(screen.getByLabelText('Compass')).toBeOnTheScreen();
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
