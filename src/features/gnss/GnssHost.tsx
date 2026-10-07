import { activeProfile } from '@core/gnss/config';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { reportError } from '@lib/errorReporting';
import { useGnssStore } from '@state/gnssStore';
import { useEffect } from 'react';

import { gnssSession } from './session';

/**
 * Keeps the receiver session in step with Settings, app-wide (root layout):
 * connected while the GNSS extension is installed and switched on and a
 * receiver is paired; corrections restarted when the active NTRIP profile
 * changes. Renders nothing; costs nothing while the extension isn't installed.
 */
export function GnssHost() {
  const { installedAt, show } = useExtensionPrefs('gnss');
  const installed = installedAt > 0;
  const hydrated = useGnssStore((s) => s.hydrated);
  const receiverId = useGnssStore((s) => s.config.receiver?.id ?? null);
  const receiverName = useGnssStore((s) => s.config.receiver?.name ?? '');
  const transport = useGnssStore((s) => s.config.receiver?.transport ?? null);
  const profileKey = useGnssStore((s) => JSON.stringify(activeProfile(s.config)));

  useEffect(() => {
    if (installed)
      useGnssStore
        .getState()
        .hydrate()
        .catch((e) => reportError(e, 'gnss-hydrate'));
  }, [installed]);

  const want = installed && show && hydrated && receiverId !== null && transport !== null;

  useEffect(() => {
    const session = gnssSession();
    if (session === null) return;
    if (!want || receiverId === null || transport === null) {
      session.stop();
      return;
    }
    session.start({ id: receiverId, name: receiverName, transport });
  }, [want, receiverId, receiverName, transport]);

  useEffect(() => {
    if (!want) return;
    gnssSession()
      ?.refreshCorrections()
      .catch((e) => reportError(e, 'gnss-ntrip'));
  }, [want, profileKey]);

  return null;
}
