import { receiverChip, type ChipLink, type ReceiverChip } from '@core/gnss/chip';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { gnssLinkAvailable } from '@data/gnss/link';
import { useGnssStore } from '@state/gnssStore';
import { useEffect, useState } from 'react';

/** A clock for the chip's ages ("Receiver lost · 12 s"). */
function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/**
 * The receiver is in use: the extension is installed and switched on, a
 * receiver is paired, and this build can reach one.
 */
export function useGnssActive(): boolean {
  const { installedAt, show } = useExtensionPrefs('gnss');
  const paired = useGnssStore((s) => s.config.receiver !== null);
  return installedAt > 0 && show && paired && gnssLinkAvailable();
}

function chipLink(link: string): ChipLink {
  if (link === 'connected' || link === 'reconnecting') return link;
  if (link === 'connecting') return 'connecting';
  return 'disconnected';
}

/** The receiver chip's model, or null when no receiver is in use. */
export function useReceiverChip(): ReceiverChip | null {
  const active = useGnssActive();
  const link = useGnssStore((s) => s.link);
  const status = useGnssStore((s) => s.status);
  const fix = useGnssStore((s) => s.fix);
  const using = useGnssStore((s) => s.use);
  const phoneAccuracyM = useGnssStore((s) => s.phoneAccuracyM);
  const fallback = useGnssStore((s) => s.config.fallbackToPhone);
  const now = useNow(1000, active);
  if (!active) return null;
  return receiverChip({
    link: link === 'idle' ? 'connecting' : chipLink(link),
    status,
    fix,
    using,
    phoneAccuracyM,
    fallback,
    nowMs: now,
  });
}
