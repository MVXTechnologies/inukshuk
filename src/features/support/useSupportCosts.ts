import type { CostsDocument } from '@core/support/costs';
import { loadSupportCosts } from '@data/supportCosts';
import { useEffect, useState } from 'react';

/**
 * The public accounts for the Support screen: null while loading and when
 * unavailable (offline with no cached copy) — the screen leaves the numbers
 * out rather than show a placeholder.
 */
export function useSupportCosts(): CostsDocument | null {
  const [doc, setDoc] = useState<CostsDocument | null>(null);
  useEffect(() => {
    let alive = true;
    loadSupportCosts()
      .then((result) => {
        if (alive && result !== null) setDoc(result.doc);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return doc;
}
