import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** Refresh daily buckets at local midnight, or immediately after resuming. */
export function useDashboardClock(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clear();
      const current = Date.now();
      const midnight = new Date(current);
      // Calendar arithmetic respects 23/25-hour daylight-saving days.
      midnight.setHours(24, 0, 0, 0);
      timer = setTimeout(refresh, Math.max(1, midnight.getTime() - current));
    };
    const refresh = () => {
      if (disposed) return;
      setNow(Date.now());
      schedule();
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (disposed) return;
      if (state === 'active') refresh();
      else clear();
    });
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') schedule();
    return () => {
      disposed = true;
      clear();
      subscription.remove();
    };
  }, []);

  return now;
}
