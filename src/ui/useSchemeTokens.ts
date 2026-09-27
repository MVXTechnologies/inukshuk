import { useTheme } from 'react-native-paper';

import { useDisplayCondition } from './displayCondition';
import { nightScheme, schemeTokens, sunlightScheme, type SchemeTokens } from './tokens';

/** The Stone & Paper semantic colours for the active colour scheme and display mode. */
export function useSchemeTokens(): SchemeTokens {
  const condition = useDisplayCondition();
  const { dark } = useTheme();
  if (condition === 'sunlight') return sunlightScheme;
  if (condition === 'night') return nightScheme;
  return schemeTokens(dark);
}
