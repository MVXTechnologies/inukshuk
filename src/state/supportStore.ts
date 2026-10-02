import { EMPTY_LEDGER, recordTip, sanitizeLedger, type TipLedger } from '@core/support/donors';
import * as storage from '@data/storage';
import { create } from 'zustand';

/**
 * The device's own giving (#476): the running USD total of finished tips,
 * their transaction ids and whether a donor name was sent. `support.json` in
 * the document directory; nothing leaves the device except the ids the person
 * chooses to send along with a donor name.
 */

const FILE = 'support.json';

type Tip = { productId: string; transactionId: string | null };

interface SupportState extends TipLedger {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Count one finished tip (idempotent per transaction id). */
  recordTip: (tip: Tip) => void;
  markDonorSubmitted: () => void;
}

function ledgerOf(s: TipLedger): TipLedger {
  return {
    totalCents: s.totalCents,
    tipCount: s.tipCount,
    transactionIds: s.transactionIds,
    donorSubmitted: s.donorSubmitted,
  };
}

/**
 * What happened before the file was read (a purchase, the launch sweep, a
 * submission), replayed over the saved ledger at hydration so nothing is lost
 * and nothing counted twice.
 */
let pendingTips: Tip[] = [];
let pendingSubmitted = false;
let hydration: Promise<void> | null = null;

export const useSupportStore = create<SupportState>((set, get) => {
  const save = (next: TipLedger) => {
    set(next);
    try {
      storage.writeJson(FILE, next);
    } catch {
      // Disk full: the total stays right in memory and is written next time.
    }
  };

  return {
    ...EMPTY_LEDGER,
    hydrated: false,

    hydrate: () => {
      hydration ??= (async () => {
        let ledger = sanitizeLedger(await storage.readJson<unknown>(FILE).catch(() => null));
        const replay = pendingTips.length > 0 || pendingSubmitted;
        for (const tip of pendingTips) ledger = recordTip(ledger, tip);
        if (pendingSubmitted) ledger = { ...ledger, donorSubmitted: true };
        pendingTips = [];
        pendingSubmitted = false;
        set({ ...ledger, hydrated: true });
        if (replay) save(ledger);
      })().finally(() => {
        hydration = null;
      });
      return hydration;
    },

    recordTip: (tip) => {
      const current = ledgerOf(get());
      const next = recordTip(current, tip);
      if (next === current) return;
      if (get().hydrated) {
        save(next);
      } else {
        pendingTips.push(tip);
        set(next);
      }
    },

    markDonorSubmitted: () => {
      const next = { ...ledgerOf(get()), donorSubmitted: true };
      if (get().hydrated) {
        save(next);
      } else {
        pendingSubmitted = true;
        set(next);
      }
    },
  };
});
