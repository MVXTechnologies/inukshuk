import type { ViewStyle } from 'react-native';

import { useDisplayCondition } from './displayCondition';
import { useSchemeTokens } from './useSchemeTokens';

/**
 * Sunlight (decision 4): every piece of map chrome gets a 2 dp outline in its
 * ink, so white buttons still separate from a sunlit map. Null otherwise.
 */
export function useChromeOutline(): ViewStyle | null {
  const condition = useDisplayCondition();
  const tokens = useSchemeTokens();
  return condition === 'sunlight' ? { borderWidth: 2, borderColor: tokens.map.chromeInk } : null;
}
