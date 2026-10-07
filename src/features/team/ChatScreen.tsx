/**
 * The team channel (#589, mockup `team-chat`): everyone's messages, newest at
 * the bottom; a message can go to the whole team or to a role, a group or
 * its leads (the core's audiences), as normal, important or — admins —
 * urgent. `@Name` mentions buzz that person. Messages you're not in the
 * audience of are not shown (they still pass through your phone, encrypted).
 */
import { audienceChoices, findMentions } from '@core/teamui/compose';
import type { ChatMessage } from '@core/teamui/view';
import { teamService, useTeamStore } from '@state/teamStore';
import { HeaderAction } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { IconButton, Text, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MemberAvatar } from './components';
import { sendTeamComment } from './taskSend';

function time(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === today.toDateString()
    ? hm
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`;
}

function Bubble({ m, initials }: { m: ChatMessage; initials: string }) {
  const t = useSchemeTokens();
  const tag = m.priority === 2 ? 'URGENT' : m.priority === 1 ? 'IMPORTANT' : null;
  return (
    <View style={styles.msg} testID={`team-msg-${m.mine ? 'mine' : 'theirs'}`}>
      <MemberAvatar initials={initials} color={m.authorColor} size={30} />
      <View style={styles.flex}>
        <Text variant="labelLarge" style={{ color: t.ink }}>
          {m.mine ? 'You' : m.authorName}
          <Text variant="bodySmall" style={{ color: t.inkMuted }}>
            {'  '}
            {time(m.at)}
            {m.audience ? ` · to ${m.audience}` : ''}
          </Text>
        </Text>
        {tag !== null && (
          <Text
            style={[
              styles.tag,
              { color: m.priority === 2 ? t.status.gpsLostInk : t.status.pausedInk },
            ]}
          >
            {tag}
          </Text>
        )}
        <Text
          variant="bodyLarge"
          style={[{ color: t.ink }, m.mentionsMe && { fontWeight: '700' }]}
          selectable
        >
          {m.text}
        </Text>
      </View>
    </View>
  );
}

export function ChatScreen() {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const view = useTeamStore((s) => s.view);
  const [text, setText] = useState('');
  const [audienceId, setAudienceId] = useState('all');
  const [priority, setPriority] = useState<0 | 1 | 2>(0);
  const choices = useMemo(() => audienceChoices(view?.groups ?? []), [view?.groups]);
  const audience = choices.find((c) => c.id === audienceId) ?? choices[0]!;
  const initialsOf = useMemo(
    () => new Map((view?.members ?? []).map((m) => [m.id, m.initials])),
    [view?.members],
  );

  // Reading the chat marks it read.
  const count = view?.messages.length ?? 0;
  useEffect(() => {
    teamService()?.active?.markRead();
  }, [count]);

  if (view === null) return <View style={[styles.flex, { backgroundColor: t.background }]} />;

  const send = () => {
    const session = teamService()?.active;
    if (!session) return;
    // `+task @name …` in the chat makes a task too (no place).
    const err = sendTeamComment({
      session,
      text,
      members: view.members,
      anchor: null,
      write: (id) =>
        session.sendMessage(text, {
          ...(audience.aud ? { aud: audience.aud } : {}),
          ...(priority ? { pr: priority } : {}),
          mentions: findMentions(text, view.members),
          id,
        }),
    });
    if (err !== null) Alert.alert('Not sent', err);
    else {
      setText('');
      setPriority(0);
      useTeamStore.getState().refresh();
    }
  };

  const cyclePriority = () => setPriority((p) => (p === 0 ? 1 : p === 1 && view.isAdmin ? 2 : 0));
  const canWrite = view.active && !view.readOnly;
  const big = view.activeCount > 30;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.flex, { backgroundColor: t.background, paddingTop: insets.top }]}
      testID="team-chat-screen"
    >
      <View style={styles.header}>
        <HeaderAction icon="arrow-left" onPress={() => router.back()} accessibilityLabel="Back" />
        <View style={styles.flex}>
          <Text
            accessibilityRole="header"
            style={[styles.title, { color: t.ink }]}
            numberOfLines={1}
          >
            {view.name}
          </Text>
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            {view.activeCount} members · end-to-end encrypted
          </Text>
        </View>
      </View>
      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={[...view.messages].reverse()}
        inverted
        keyExtractor={(m) => m.key}
        renderItem={({ item }) => <Bubble m={item} initials={initialsOf.get(item.author) ?? '?'} />}
        ListEmptyComponent={
          <Text variant="bodyMedium" style={[styles.empty, { color: t.inkVariant }]}>
            No messages yet. Everything here stays on the team’s phones.
          </Text>
        }
      />
      <View style={styles.bottom}>
        {big && (
          <Text variant="bodySmall" style={{ color: t.inkMuted }}>
            {view.activeCount} people: ordinary messages don’t buzz phones. Use Important or a group
            to reach people.
          </Text>
        )}
        {canWrite && (
          <View style={[styles.composer, { borderTopColor: t.outlineVariant }]}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
              keyboardShouldPersistTaps="handled"
            >
              {choices.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => setAudienceId(c.id)}
                  style={[
                    styles.chip,
                    {
                      borderColor: c.id === audienceId ? t.ink : t.outlineVariant,
                      backgroundColor: c.id === audienceId ? t.surfaceVariant : 'transparent',
                    },
                  ]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: c.id === audienceId }}
                  testID={`team-chat-to-${c.id}`}
                >
                  <Text
                    style={[styles.chipText, { color: c.id === audienceId ? t.ink : t.inkVariant }]}
                  >
                    {c.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.row}>
              <IconButton
                icon={
                  priority === 2
                    ? 'alert'
                    : priority === 1
                      ? 'alert-circle'
                      : 'alert-circle-outline'
                }
                iconColor={
                  priority === 2
                    ? t.status.gpsLostInk
                    : priority === 1
                      ? t.status.pausedInk
                      : t.inkVariant
                }
                onPress={cyclePriority}
                accessibilityLabel={
                  priority === 2 ? 'Urgent' : priority === 1 ? 'Important' : 'Normal priority'
                }
                testID="team-chat-priority"
              />
              <TextInput
                mode="outlined"
                dense
                style={styles.flex}
                value={text}
                onChangeText={setText}
                placeholder={audience.aud ? `To ${audience.label}` : 'Message the team'}
                returnKeyType="send"
                onSubmitEditing={send}
                submitBehavior="submit"
                maxLength={4000}
                testID="team-chat-input"
              />
              <IconButton
                icon="send"
                mode="contained"
                onPress={send}
                disabled={text.trim().length === 0}
                accessibilityLabel="Send"
                testID="team-chat-send"
              />
            </View>
          </View>
        )}
      </View>
      <View style={{ height: insets.bottom }} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.xs,
    paddingRight: space.lg,
    gap: space.xs,
  },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '800' },
  list: { paddingHorizontal: space.lg },
  bottom: { paddingHorizontal: space.lg },
  msg: { flexDirection: 'row', gap: space.sm, paddingVertical: 8 },
  tag: { fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  empty: { textAlign: 'center', paddingVertical: space.xl },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, gap: space.xs },
  chips: { flexDirection: 'row', gap: space.xs },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center' },
});
