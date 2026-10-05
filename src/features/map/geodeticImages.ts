import type { ImageRequireSource } from 'react-native';
import type { GeodeticTheme } from '@core/map/geodeticStyle';

/**
 * The geodetic-point symbols (`scripts/map/build-geodetic-icons.py` →
 * assets/map/geodetic, @1x/@2x/@3x), keyed by the image names the style asks
 * for (`geodeticIconNames`). Metro needs literal requires, hence the table.
 * Bundled assets: they ship with the JS bundle (and with OTA updates).
 */
const IMAGES: Record<GeodeticTheme, Record<string, ImageRequireSource>> = {
  light: {
    'geodetic-3d-light': require('../../../assets/map/geodetic/geodetic-3d-light.png'),
    'geodetic-3d-o-light': require('../../../assets/map/geodetic/geodetic-3d-o-light.png'),
    'geodetic-h-light': require('../../../assets/map/geodetic/geodetic-h-light.png'),
    'geodetic-h-o-light': require('../../../assets/map/geodetic/geodetic-h-o-light.png'),
    'geodetic-v-light': require('../../../assets/map/geodetic/geodetic-v-light.png'),
    'geodetic-v-o-light': require('../../../assets/map/geodetic/geodetic-v-o-light.png'),
    'geodetic-gnss-light': require('../../../assets/map/geodetic/geodetic-gnss-light.png'),
    'geodetic-gnss-o-light': require('../../../assets/map/geodetic/geodetic-gnss-o-light.png'),
    'geodetic-u-light': require('../../../assets/map/geodetic/geodetic-u-light.png'),
    'geodetic-u-o-light': require('../../../assets/map/geodetic/geodetic-u-o-light.png'),
    'geodetic-tbm-light': require('../../../assets/map/geodetic/geodetic-tbm-light.png'),
  },
  dark: {
    'geodetic-3d-dark': require('../../../assets/map/geodetic/geodetic-3d-dark.png'),
    'geodetic-3d-o-dark': require('../../../assets/map/geodetic/geodetic-3d-o-dark.png'),
    'geodetic-h-dark': require('../../../assets/map/geodetic/geodetic-h-dark.png'),
    'geodetic-h-o-dark': require('../../../assets/map/geodetic/geodetic-h-o-dark.png'),
    'geodetic-v-dark': require('../../../assets/map/geodetic/geodetic-v-dark.png'),
    'geodetic-v-o-dark': require('../../../assets/map/geodetic/geodetic-v-o-dark.png'),
    'geodetic-gnss-dark': require('../../../assets/map/geodetic/geodetic-gnss-dark.png'),
    'geodetic-gnss-o-dark': require('../../../assets/map/geodetic/geodetic-gnss-o-dark.png'),
    'geodetic-u-dark': require('../../../assets/map/geodetic/geodetic-u-dark.png'),
    'geodetic-u-o-dark': require('../../../assets/map/geodetic/geodetic-u-o-dark.png'),
    'geodetic-tbm-dark': require('../../../assets/map/geodetic/geodetic-tbm-dark.png'),
  },
};

export function geodeticImages(theme: GeodeticTheme): Record<string, ImageRequireSource> {
  return IMAGES[theme];
}

/** One symbol, for legends and the card's type badge. */
export function geodeticImage(
  theme: GeodeticTheme,
  kind: string,
  hollow = false,
): ImageRequireSource | undefined {
  return IMAGES[theme][`geodetic-${kind}${hollow ? '-o' : ''}-${theme}`];
}
