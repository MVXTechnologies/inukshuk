import type { ImageRequireSource } from 'react-native';
import type { TideTheme } from '@core/map/tideStyle';

/**
 * The tide-station symbols (`scripts/map/build-tide-icons.py` →
 * assets/map/tides, @1x/@2x/@3x), keyed by the image names the style asks for
 * (`tideIconNames`). Metro needs literal requires, hence the table. Bundled:
 * they ship with the JS bundle (and with OTA updates).
 */
const IMAGES: Record<TideTheme, Record<string, ImageRequireSource>> = {
  light: {
    'tide-gauge-light': require('../../../assets/map/tides/tide-gauge-light.png'),
    'tide-pred-light': require('../../../assets/map/tides/tide-pred-light.png'),
  },
  dark: {
    'tide-gauge-dark': require('../../../assets/map/tides/tide-gauge-dark.png'),
    'tide-pred-dark': require('../../../assets/map/tides/tide-pred-dark.png'),
  },
};

/**
 * The water level labels' images (#764, `scripts/map/build-tide-level-images.py`):
 * SDF pills the style tints (one set for both themes) and the trend arrows,
 * named as `tideLevelImageNames` lists them.
 */
const PILLS: Record<string, ImageRequireSource> = {
  'tide-pill-1-48': require('../../../assets/map/tides/levels/tide-pill-1-48.png'),
  'tide-pill-1-64': require('../../../assets/map/tides/levels/tide-pill-1-64.png'),
  'tide-pill-1-80': require('../../../assets/map/tides/levels/tide-pill-1-80.png'),
  'tide-pill-1-104': require('../../../assets/map/tides/levels/tide-pill-1-104.png'),
  'tide-pill-1-128': require('../../../assets/map/tides/levels/tide-pill-1-128.png'),
  'tide-pill-1-152': require('../../../assets/map/tides/levels/tide-pill-1-152.png'),
  'tide-pill-1-184': require('../../../assets/map/tides/levels/tide-pill-1-184.png'),
  'tide-pill-1-216': require('../../../assets/map/tides/levels/tide-pill-1-216.png'),
  'tide-pill-2-48': require('../../../assets/map/tides/levels/tide-pill-2-48.png'),
  'tide-pill-2-64': require('../../../assets/map/tides/levels/tide-pill-2-64.png'),
  'tide-pill-2-80': require('../../../assets/map/tides/levels/tide-pill-2-80.png'),
  'tide-pill-2-104': require('../../../assets/map/tides/levels/tide-pill-2-104.png'),
  'tide-pill-2-128': require('../../../assets/map/tides/levels/tide-pill-2-128.png'),
  'tide-pill-2-152': require('../../../assets/map/tides/levels/tide-pill-2-152.png'),
  'tide-pill-2-184': require('../../../assets/map/tides/levels/tide-pill-2-184.png'),
  'tide-pill-2-216': require('../../../assets/map/tides/levels/tide-pill-2-216.png'),
};

const ARROWS: Record<TideTheme, Record<string, ImageRequireSource>> = {
  light: {
    'tide-arr-up-ink-light': require('../../../assets/map/tides/levels/tide-arr-up-ink-light.png'),
    'tide-arr-up-label-light': require('../../../assets/map/tides/levels/tide-arr-up-label-light.png'),
    'tide-arr-down-ink-light': require('../../../assets/map/tides/levels/tide-arr-down-ink-light.png'),
    'tide-arr-down-label-light': require('../../../assets/map/tides/levels/tide-arr-down-label-light.png'),
    'tide-arr-flat-ink-light': require('../../../assets/map/tides/levels/tide-arr-flat-ink-light.png'),
    'tide-arr-flat-label-light': require('../../../assets/map/tides/levels/tide-arr-flat-label-light.png'),
  },
  dark: {
    'tide-arr-up-ink-dark': require('../../../assets/map/tides/levels/tide-arr-up-ink-dark.png'),
    'tide-arr-up-label-dark': require('../../../assets/map/tides/levels/tide-arr-up-label-dark.png'),
    'tide-arr-down-ink-dark': require('../../../assets/map/tides/levels/tide-arr-down-ink-dark.png'),
    'tide-arr-down-label-dark': require('../../../assets/map/tides/levels/tide-arr-down-label-dark.png'),
    'tide-arr-flat-ink-dark': require('../../../assets/map/tides/levels/tide-arr-flat-ink-dark.png'),
    'tide-arr-flat-label-dark': require('../../../assets/map/tides/levels/tide-arr-flat-label-dark.png'),
  },
};

export function tideImages(theme: TideTheme): Record<string, ImageRequireSource> {
  return IMAGES[theme];
}

/** The level labels' images for a theme: pills (SDF) and arrows. */
export function tideLevelImages(
  theme: TideTheme,
): Record<string, ImageRequireSource | { source: ImageRequireSource; sdf: boolean }> {
  const out: Record<string, ImageRequireSource | { source: ImageRequireSource; sdf: boolean }> = {
    ...ARROWS[theme],
  };
  for (const [name, source] of Object.entries(PILLS)) out[name] = { source, sdf: true };
  return out;
}

/** One symbol, for the legend and the card header. */
export function tideImage(theme: TideTheme, live: boolean): ImageRequireSource | undefined {
  return IMAGES[theme][`tide-${live ? 'gauge' : 'pred'}-${theme}`];
}
