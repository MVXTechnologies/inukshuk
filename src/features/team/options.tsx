/**
 * Team mode's options, one source for both places they show (#668):
 * Settings › Extensions › Team mode (`variant 'settings'`, Paper list items)
 * and the overlays sheet's Team sub-panel (`'sheet'`, the sheet's rows).
 * Each opens the same screen; in the sheet, `onLeave` closes the sheet first.
 */
import { teamService, useTeamStore } from '@state/teamStore';
import { useRouter, type Href } from 'expo-router';
import { List } from 'react-native-paper';

import { NavRow } from '../map/components/mapSheet';

export type TeamOptionVariant = 'settings' | 'sheet';

interface OptionProps {
  variant: TeamOptionVariant;
  /** Called before a row leaves for a screen (the sheet closes itself). */
  onLeave?: () => void;
}

/** The privacy line under the team options, wherever they show. */
export const TEAM_PRIVACY_NOTE = 'Your position is shared only while you turn sharing on.';

function useGo(onLeave: (() => void) | undefined): (href: Href) => void {
  const router = useRouter();
  return (href) => {
    onLeave?.();
    router.push(href);
  };
}

/** "Your teams" — shown once there is more than one team on this phone. */
export function TeamYourTeamsOption({ variant, onLeave }: OptionProps) {
  const go = useGo(onLeave);
  const count = useTeamStore((s) => s.teams.length);
  if (count <= 1) return null;
  const hint = `${count} teams on this phone`;
  if (variant === 'sheet') {
    return (
      <NavRow
        icon="format-list-bulleted"
        label="Your teams"
        hint={hint}
        onPress={() => go('/team/teams')}
      />
    );
  }
  return (
    <List.Item
      title="Your teams"
      description={hint}
      left={(p) => <List.Icon {...p} icon="format-list-bulleted" />}
      right={(p) => <List.Icon {...p} icon="chevron-right" />}
      onPress={() => go('/team/teams')}
    />
  );
}

const CREATE_HINT = 'Name it, then invite people';
const JOIN_HINT = 'Scan a QR code or paste an invite';

export function TeamCreateOption({ variant, onLeave }: OptionProps) {
  const go = useGo(onLeave);
  if (variant === 'sheet') {
    return (
      <NavRow
        icon="plus"
        label="Create a team"
        hint={CREATE_HINT}
        onPress={() => go('/team/create')}
      />
    );
  }
  return (
    <List.Item
      title="Create a team"
      description={CREATE_HINT}
      left={(p) => <List.Icon {...p} icon="plus" />}
      onPress={() => go('/team/create')}
      testID="team-create-row"
    />
  );
}

export function TeamJoinOption({ variant, onLeave }: OptionProps) {
  const go = useGo(onLeave);
  if (variant === 'sheet') {
    return (
      <NavRow
        icon="qrcode-scan"
        label="Join a team"
        hint={JOIN_HINT}
        onPress={() => go('/team/join')}
      />
    );
  }
  return (
    <List.Item
      title="Join a team"
      description={JOIN_HINT}
      left={(p) => <List.Icon {...p} icon="qrcode-scan" />}
      onPress={() => go('/team/join')}
      testID="team-join-row"
    />
  );
}

/**
 * "Share my position" for the open team (its `prefs.sharePosition`, the
 * team hub's switch): null while no team is open or it is read-only.
 */
export function useSharePosition(): { on: boolean; set: (on: boolean) => void } | null {
  const record = useTeamStore((s) => s.record);
  const readOnly = useTeamStore((s) => s.view?.readOnly ?? true);
  if (record === null || readOnly) return null;
  return {
    on: record.prefs.sharePosition,
    set: (on) =>
      teamService()?.active?.updateRecord({ prefs: { ...record.prefs, sharePosition: on } }),
  };
}
