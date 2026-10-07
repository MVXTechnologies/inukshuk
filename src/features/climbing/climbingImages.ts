import type { ImageRequireSource } from 'react-native';
import type { ClimbingTheme } from '@core/map/climbingStyle';

/**
 * The crag badges (`scripts/map/build-crag-icons.py` → assets/map/climbing,
 * @1x/@2x/@3x), keyed by the image names the layers ask for
 * (`climbingIconNames`). Metro needs literal requires, hence the table.
 */
const IMAGES: Record<ClimbingTheme, Record<string, ImageRequireSource>> = {
  light: {
    'crag-hollow-light': require('../../../assets/map/climbing/crag-hollow-light.png'),
    'crag-saved-light': require('../../../assets/map/climbing/crag-saved-light.png'),
    'crag-closed-light': require('../../../assets/map/climbing/crag-closed-light.png'),
  },
  dark: {
    'crag-hollow-dark': require('../../../assets/map/climbing/crag-hollow-dark.png'),
    'crag-saved-dark': require('../../../assets/map/climbing/crag-saved-dark.png'),
    'crag-closed-dark': require('../../../assets/map/climbing/crag-closed-dark.png'),
  },
};

export function climbingImages(theme: ClimbingTheme): Record<string, ImageRequireSource> {
  return IMAGES[theme];
}

export function cragBadgeImage(theme: ClimbingTheme, kind: 'hollow' | 'saved' | 'closed') {
  return IMAGES[theme][`crag-${kind}-${theme}`];
}
