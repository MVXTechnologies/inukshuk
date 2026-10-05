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

export function tideImages(theme: TideTheme): Record<string, ImageRequireSource> {
  return IMAGES[theme];
}

/** One symbol, for the legend and the card header. */
export function tideImage(theme: TideTheme, live: boolean): ImageRequireSource | undefined {
  return IMAGES[theme][`tide-${live ? 'gauge' : 'pred'}-${theme}`];
}
