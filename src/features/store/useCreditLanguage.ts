import type { CreditLanguage } from '@core/catalog/credit';
import { useMemo } from 'react';

import { deviceSearchLanguage } from '../map/search/deviceLanguage';

/**
 * The language credit lines are written in (`@core/catalog/credit`): French
 * on a French device, English otherwise — the rule place-name search uses.
 * Read once per mounted screen, not per row render.
 */
export function useCreditLanguage(): CreditLanguage {
  return useMemo(() => deviceSearchLanguage(), []);
}
