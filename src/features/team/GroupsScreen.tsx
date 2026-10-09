/**
 * Groups (#589, owner B4: hierarchies for 100+ teams): a tree of crews and
 * sub-crews with leads. Messages can target a group's subtree or its leads.
 * Admins create groups and put members in them (Member screen).
 */
import { teamService, useTeamStore } from '@state/teamStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

import { ChoiceRow, Note, SectionLabel, TeamScreenFrame } from './components';
import { actionMessage } from './messages';

export function GroupsScreen() {
  const t = useSchemeTokens();
  const view = useTeamStore((s) => s.view);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('top');
  if (view === null) return <TeamScreenFrame title="Groups">{null}</TeamScreenFrame>;

  const create = () => {
    const err = teamService()?.active?.createGroup(name, parent === 'top' ? undefined : parent);
    if (err) Alert.alert('Not created', actionMessage(err));
    else setName('');
    useTeamStore.getState().refresh();
  };

  return (
    <TeamScreenFrame title="Groups" testID="team-groups-screen">
      {view.groups.length === 0 ? (
        <Text variant="bodyMedium" style={{ color: t.inkVariant }}>
          No groups yet.
        </Text>
      ) : (
        view.groups.map((g) => {
          const leads = view.members.filter(
            (m) => m.active && m.groups.some((x) => x.id === g.id && x.lead),
          );
          return (
            <View
              key={g.id}
              style={[styles.group, { marginLeft: g.depth * 20, borderColor: t.outlineVariant }]}
            >
              <Text variant="titleSmall" style={{ color: t.ink }}>
                {g.name}
              </Text>
              <Text variant="bodySmall" style={{ color: t.inkVariant }}>
                {g.members} member{g.members === 1 ? '' : 's'}
                {leads.length > 0 ? ` · lead: ${leads.map((m) => m.name).join(', ')}` : ''}
              </Text>
            </View>
          );
        })
      )}
      {view.isAdmin && !view.readOnly && (
        <>
          <SectionLabel>New group</SectionLabel>
          <TextInput
            returnKeyType="done"
            mode="outlined"
            label="Name"
            value={name}
            onChangeText={setName}
            maxLength={40}
            testID="team-group-name"
          />
          {view.groups.length > 0 && (
            <>
              <Text variant="bodySmall" style={{ color: t.inkVariant }}>
                Inside
              </Text>
              <ChoiceRow
                options={[
                  { id: 'top', label: 'Top level' },
                  ...view.groups.map((g) => ({ id: g.id, label: g.name })),
                ]}
                value={parent}
                onChange={setParent}
              />
            </>
          )}
          <Button
            mode="contained"
            onPress={create}
            disabled={name.trim().length === 0}
            testID="team-group-create"
          >
            Create group
          </Button>
        </>
      )}
      <Note>
        A message to a group reaches its sub-groups too. In big teams, only messages from admins and
        your group’s leads buzz your phone.
      </Note>
    </TeamScreenFrame>
  );
}

const styles = StyleSheet.create({
  group: { borderLeftWidth: 2, paddingLeft: space.md, paddingVertical: space.xs },
});
