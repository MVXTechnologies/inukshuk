/**
 * New task (#589): what to do, for whom (members and up: guests can't be
 * given tasks), and where — the pin, photo or place it was opened from, or
 * where I am, or nowhere. The same thing `+task @name …` does in a comment.
 */
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import type { TaskAnchor } from '@core/team/tasks';
import { anchorInfo } from '@core/teamui/tasks';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

import { MemberAvatar, SectionLabel, TeamScreenFrame } from './components';
import { actionMessage } from './messages';
import { useTeamPick } from './map/TeamPick';
import { useAnchorLookup } from './useAnchorLookup';

type Place = 'given' | 'here' | 'none';

function anchorFromParams(p: Record<string, string | undefined>): TaskAnchor | null {
  const { ak, ao, ai, la, lo } = p;
  if ((ak === 'photo' || ak === 'pin' || ak === 'trail') && ao && ai)
    return { kind: ak, owner: ao, id: ai };
  const lat = Number(la);
  const lng = Number(lo);
  if (ak === 'point' && Number.isFinite(lat) && Number.isFinite(lng))
    return { kind: 'point', lat, lng };
  return null;
}

export function NewTaskScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();
  const view = useTeamStore((s) => s.view);
  const look = useAnchorLookup();
  const given = anchorFromParams(params);
  // Back from "Attach to…": what was typed before.
  const draft = params['resume'] === '1' ? useTeamPick.getState().draft : null;
  const [title, setTitle] = useState(draft?.title ?? '');
  const [assignee, setAssignee] = useState<string | null>(
    draft?.assignee ?? (typeof params['to'] === 'string' ? params['to'] : null),
  );
  const [place, setPlace] = useState<Place>(
    given ? 'given' : params['ak'] === 'none' ? 'none' : 'here',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (view === null) return <TeamScreenFrame title="New task">{null}</TeamScreenFrame>;

  const people = view.members.filter((m) => m.active && m.role !== 'guest');
  const create = async () => {
    const session = teamService()?.active;
    if (!session || assignee === null) return;
    setBusy(true);
    let anchor: TaskAnchor | null = place === 'given' ? given : null;
    if (place === 'here') {
      try {
        const fix = await Location.getLastKnownPositionAsync();
        if (fix) anchor = { kind: 'point', lat: fix.coords.latitude, lng: fix.coords.longitude };
      } catch {
        // No position: the task has no place.
      }
    }
    const err = session.createTask({ title, assignee, anchor });
    setBusy(false);
    useTeamStore.getState().refresh();
    if (err) setError(actionMessage(err));
    else router.back();
  };

  const placeChoices: { id: Place; label: string }[] = [
    ...(given ? [{ id: 'given' as const, label: anchorInfo(given, look).label }] : []),
    { id: 'here', label: 'Where I am' },
    { id: 'none', label: 'No place' },
  ];
  const attach = () => {
    useTeamPick.getState().start('task', { title, assignee });
    router.navigate('/');
  };

  return (
    <TeamScreenFrame
      title="New task"
      testID="team-task-new-screen"
      footer={
        <Button
          mode="contained"
          onPress={() => void create()}
          loading={busy}
          disabled={busy || title.trim().length === 0 || assignee === null}
          testID="team-task-create"
        >
          Assign
        </Button>
      }
    >
      <TextInput
        mode="outlined"
        label="What to do"
        value={title}
        onChangeText={setTitle}
        maxLength={500}
        multiline
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        testID="team-task-title"
        inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
      />
      <KeyboardDoneBar />
      <SectionLabel>For</SectionLabel>
      <View style={styles.people}>
        {people.map((m) => {
          const on = assignee === m.id;
          return (
            <Pressable
              key={m.id}
              onPress={() => setAssignee(m.id)}
              style={[
                styles.person,
                {
                  borderColor: on ? t.ink : t.outlineVariant,
                  backgroundColor: on ? t.surfaceVariant : 'transparent',
                },
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={m.isMe ? 'Me' : m.name}
              testID={`team-task-for-${m.isMe ? 'me' : m.id}`}
            >
              <MemberAvatar initials={m.initials} color={m.color} size={26} />
              <Text variant="labelLarge" style={{ color: t.ink }}>
                {m.isMe ? 'Me' : m.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <SectionLabel>Where</SectionLabel>
      <View style={styles.people}>
        {placeChoices.map((c) => {
          const on = place === c.id;
          return (
            <Pressable
              key={c.id}
              onPress={() => setPlace(c.id)}
              style={[
                styles.person,
                {
                  borderColor: on ? t.ink : t.outlineVariant,
                  backgroundColor: on ? t.surfaceVariant : 'transparent',
                },
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              testID={`team-task-place-${c.id}`}
            >
              <Text variant="labelLarge" style={{ color: t.ink }}>
                {c.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Button
        mode="outlined"
        icon="map-marker-plus-outline"
        onPress={attach}
        testID="team-task-attach"
      >
        Attach to… a trail, a photo or the map
      </Button>
      {error !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {error}
        </Text>
      )}
    </TeamScreenFrame>
  );
}

const styles = StyleSheet.create({
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 40,
  },
});
