import { useTheme } from 'react-native-paper';

import { schemeTokens, type SchemeTokens } from './tokens';

/** The Stone & Paper semantic colours for the active colour scheme. */
export function useSchemeTokens(): SchemeTokens {
  return schemeTokens(useTheme().dark);
}
