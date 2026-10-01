import { useEffect, useState } from 'react';

/**
 * `value`, once it has stopped changing for `delayMs` — e.g. a search field
 * whose every keystroke would otherwise re-filter a 2,000-item list (#494).
 * A value for which `immediate(value)` holds is passed through at once
 * (clearing a search should not wait).
 */
export function useDebouncedValue<T>(
  value: T,
  delayMs: number,
  immediate?: (value: T) => boolean,
): T {
  const [settled, setSettled] = useState(value);
  const now = immediate?.(value) === true;
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = setTimeout(() => setSettled(value), now ? 0 : delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs, now]);
  return now ? value : settled;
}
