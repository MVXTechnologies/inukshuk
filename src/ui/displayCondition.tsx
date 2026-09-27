import type { DisplayCondition } from '@core/display/condition';
import { createContext, useContext } from 'react';

/**
 * The display mode in effect (Normal, Sunlight, Night red), provided once at
 * the root from the settings, the clock and the recorder, so any component
 * can pick the matching tokens without re-deriving it.
 */
export const DisplayConditionContext = createContext<DisplayCondition>('normal');

export function useDisplayCondition(): DisplayCondition {
  return useContext(DisplayConditionContext);
}
