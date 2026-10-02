import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { View } from 'react-native';

/**
 * Window y of the map area's bottom edge — above the tab bar, which takes its
 * own layout space below the Map screen. Sheets hanging from the control rail
 * size themselves to it (`sheetBodyMaxHeight`) so their last rows stay
 * reachable. Null until measured, and outside the Map screen.
 */
export const MapAreaBottomContext = createContext<number | null>(null);

export const useMapAreaBottom = (): number | null => useContext(MapAreaBottomContext);

/**
 * Measure a view's window-coordinate edge after layout: its top (`'top'`) or
 * its bottom (`'bottom'`). Returns the ref, the onLayout handler and the value.
 */
export function useWindowEdge(edge: 'top' | 'bottom') {
  const ref = useRef<View>(null);
  const [value, setValue] = useState<number | null>(null);
  const onLayout = useCallback(() => {
    ref.current?.measureInWindow((_x, y, _w, h) => {
      if (Number.isFinite(y) && Number.isFinite(h)) setValue(edge === 'top' ? y : y + h);
    });
  }, [edge]);
  return { ref, onLayout, value };
}
