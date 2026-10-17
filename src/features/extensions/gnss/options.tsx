/**
 * The External GNSS receiver's options, one source for both places they show
 * (#668): Settings › Extensions › External GNSS receiver (`variant
 * 'settings'`, Paper list items) and the overlays sheet's GNSS sub-panel
 * (`'sheet'`, the sheet's rows). Each option reads and writes the same
 * receiver config; only the row it is drawn as differs. In the sheet, a row
 * that leaves for a screen first closes the sheet (`onLeave`).
 */
import { stateLabel } from '@core/gnss/chip';
import { activeProfile, profileLine } from '@core/gnss/config';
import { projectDatumOption } from '@core/gnss/projectDatum';
import { useGnssStore, type NtripState } from '@state/gnssStore';
import { useRouter, type Href } from 'expo-router';
import { List, Switch } from '@ui/paper';

import { NavRow, SwitchRow } from '../../map/components/mapSheet';

export type GnssOptionVariant = 'settings' | 'sheet';

interface OptionProps {
  variant: GnssOptionVariant;
  /** Called before a row leaves for a screen (the sheet closes itself). */
  onLeave?: () => void;
}

export function linkLine(link: string, state: string | null): string {
  switch (link) {
    case 'connected':
      return state ? `connected · ${state}` : 'connected';
    case 'connecting':
      return 'connecting…';
    case 'reconnecting':
      return 'reconnecting…';
    default:
      return 'not connected';
  }
}

export function ntripLine(ntrip: NtripState): string {
  switch (ntrip.phase) {
    case 'streaming':
      return 'streaming';
    case 'connecting':
      return 'connecting…';
    case 'error':
    case 'unavailable':
      return ntrip.message ?? 'not connected';
    default:
      return 'starts with the receiver';
  }
}

/** Push `href`, after `onLeave` (the sheet closing). */
function useGo(onLeave: (() => void) | undefined): (href: Href) => void {
  const router = useRouter();
  return (href) => {
    onLeave?.();
    router.push(href);
  };
}

/** The paired receiver and its link, into Connect a receiver (pair, change, forget). */
export function GnssReceiverOption({ variant, onLeave }: OptionProps) {
  const go = useGo(onLeave);
  const receiver = useGnssStore((s) => s.config.receiver);
  const link = useGnssStore((s) => s.link);
  const status = useGnssStore((s) => s.status);
  const state = status && status.state !== 'no-fix' ? stateLabel(status.state) : null;
  const line = receiver ? `${receiver.name} · ${linkLine(link, state)}` : 'None yet — connect one';
  if (variant === 'sheet') {
    return (
      <NavRow
        icon={link === 'connected' ? 'bluetooth-connect' : 'bluetooth'}
        label={receiver ? receiver.name : 'Connect a receiver'}
        hint={receiver ? `${linkLine(link, state)} · change or forget it` : 'Scan nearby'}
        onPress={() => go('/gnss/pair')}
        accessibilityLabel={receiver ? `Receiver: ${receiver.name}` : 'Connect a receiver'}
      />
    );
  }
  return (
    <List.Item
      title="Receiver"
      description={line}
      onPress={() => go('/gnss/pair')}
      right={(p) => <List.Icon {...p} icon="chevron-right" />}
      testID="gnss-receiver-row"
    />
  );
}

/** RTK corrections: the active caster profile and its stream, into its screen. */
export function GnssCorrectionsOption({ variant, onLeave }: OptionProps) {
  const go = useGo(onLeave);
  const config = useGnssStore((s) => s.config);
  const ntrip = useGnssStore((s) => s.ntrip);
  const profile = activeProfile(config);
  const line = profile
    ? `${profileLine(profile)} · ${ntripLine(ntrip)}`
    : 'Off · add a caster for centimetre RTK';
  if (variant === 'sheet') {
    return (
      <NavRow
        icon="radio-tower"
        label="RTK corrections (NTRIP)"
        hint={line}
        onPress={() => go('/gnss/corrections')}
      />
    );
  }
  return (
    <List.Item
      title="RTK corrections (NTRIP)"
      description={line}
      descriptionNumberOfLines={3}
      onPress={() => go('/gnss/corrections')}
      right={(p) => <List.Icon {...p} icon="chevron-right" />}
      testID="gnss-corrections-row"
    />
  );
}

/** The project datum the receiver's coordinates are shown in, into its screen. */
export function GnssDatumOption({ variant, onLeave }: OptionProps) {
  const go = useGo(onLeave);
  const datumId = useGnssStore((s) => s.config.projectDatumId);
  const label = projectDatumOption(datumId).label;
  if (variant === 'sheet') {
    return (
      <NavRow
        icon="earth"
        label="Project datum"
        hint={`${label} · coordinates in Live view`}
        onPress={() => go('/gnss/datum')}
      />
    );
  }
  return (
    <List.Item
      title="Project datum"
      description={`${label} · coordinates in the receiver sheet`}
      descriptionNumberOfLines={2}
      onPress={() => go('/gnss/datum')}
      right={(p) => <List.Icon {...p} icon="chevron-right" />}
      testID="gnss-datum-row"
    />
  );
}

const FALLBACK_LABEL = 'Use the phone GPS when the receiver drops';
const FALLBACK_HINT = 'The chip says which one you’re on';

/** Fall back to the phone's GPS when the receiver drops. */
export function GnssFallbackOption({ variant }: OptionProps) {
  const value = useGnssStore((s) => s.config.fallbackToPhone);
  const set = (v: boolean) => useGnssStore.getState().updateConfig({ fallbackToPhone: v });
  if (variant === 'sheet') {
    return (
      <SwitchRow
        icon="cellphone"
        label="Phone GPS when it drops"
        hint={FALLBACK_HINT}
        value={value}
        onToggle={() => set(!value)}
        accessibilityLabel={FALLBACK_LABEL}
      />
    );
  }
  return (
    <List.Item
      title={FALLBACK_LABEL}
      titleNumberOfLines={2}
      description={FALLBACK_HINT}
      right={() => <Switch value={value} onValueChange={set} accessibilityLabel={FALLBACK_LABEL} />}
    />
  );
}

/** The phone's GPS while the receiver is good: low-power standby, or off. */
export function GnssStandbyOption({ variant }: OptionProps) {
  const standby = useGnssStore((s) => s.config.phoneWhileGood === 'standby');
  const set = (v: boolean) =>
    useGnssStore.getState().updateConfig({ phoneWhileGood: v ? 'standby' : 'off' });
  if (variant === 'sheet') {
    return (
      <SwitchRow
        icon="battery-heart-variant"
        label="Phone GPS in standby"
        hint={
          standby ? 'Low power, for an instant fallback' : 'Off: saves battery, slower fallback'
        }
        value={standby}
        onToggle={() => set(!standby)}
      />
    );
  }
  return (
    <List.Item
      title="Phone GPS in standby"
      description={
        standby
          ? 'Low power while the receiver is good, for an instant fallback'
          : 'Off while the receiver is good: saves battery, slower fallback'
      }
      descriptionNumberOfLines={2}
      right={() => (
        <Switch value={standby} onValueChange={set} accessibilityLabel="Phone GPS in standby" />
      )}
    />
  );
}
