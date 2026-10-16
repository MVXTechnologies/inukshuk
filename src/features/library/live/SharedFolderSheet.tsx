import type { LiveFolder } from '@data/sync/liveFolders';
import { palette, space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

import { LibrarySheet, SheetDivider, SheetRow, sheetStyles } from '../selection/LibrarySheet';

/**
 * A shared folder's (or item's) own sheet (#712, G10 mockup 6), from its ⋮:
 * People, Activity, Recently deleted, Sync, then Send a copy, and Stop
 * sharing (its owner) or Leave folder (everyone else). Everything tied to
 * this one share lives here, never as greyed-out rows elsewhere.
 */
export function SharedFolderSheet({
  folder,
  focused,
  onPeople,
  onActivity,
  onTrash,
  onSendCopy,
  onStop,
  onLeave,
  onClose,
}: {
  folder: LiveFolder | null;
  focused: boolean;
  onPeople: () => void;
  onActivity: () => void;
  onTrash: () => void;
  onSendCopy?: () => void;
  onStop: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const f = folder;
  const detail = (text: string, tone?: 'ok' | 'wait') => (
    <Text
      numberOfLines={2}
      style={[
        sheetStyles.detail,
        {
          color:
            tone === 'ok' ? t.status.gnssFixed : tone === 'wait' ? t.status.pausedInk : t.inkMuted,
        },
      ]}
    >
      {text}
    </Text>
  );
  const chevron = <Icon source="chevron-right" size={24} color={t.inkMuted} />;
  const icon = (name: string, color = t.ink) => <Icon source={name} size={22} color={color} />;
  return (
    <LibrarySheet
      visible={f !== null}
      focused={focused}
      title={f?.name ?? ''}
      subtitle={f?.subtitle}
      onClose={onClose}
      testID="library-shared-sheet"
    >
      {f !== null && (
        <>
          <SheetRow
            icon={icon('account-multiple-outline')}
            label="People"
            detail={detail(f.peopleSummary)}
            trailing={chevron}
            onPress={onPeople}
            testID="shared-sheet-people"
          />
          <SheetRow
            icon={icon('history')}
            label="Activity"
            detail={
              <View style={styles.activity}>
                {f.toReview > 0 && (
                  <Text
                    style={[
                      styles.review,
                      { color: t.status.pausedInk, backgroundColor: t.surfaceVariant },
                    ]}
                  >
                    {`${f.toReview} to review`}
                  </Text>
                )}
                {detail(
                  f.changesToday === 0
                    ? 'No changes today'
                    : `${f.changesToday} ${f.changesToday === 1 ? 'change' : 'changes'} today`,
                )}
              </View>
            }
            trailing={chevron}
            onPress={onActivity}
            testID="shared-sheet-activity"
          />
          <SheetRow
            icon={icon('trash-can-outline')}
            label="Recently deleted"
            detail={detail(f.trashCount === 1 ? '1 item' : `${f.trashCount} items`)}
            trailing={chevron}
            onPress={onTrash}
            testID="shared-sheet-trash"
          />
          <SheetRow
            icon={icon(f.line.tone === 'wait' ? 'cloud-off-outline' : 'cloud-check-outline')}
            label="Sync"
            detail={detail(f.line.text, f.line.tone === 'wait' ? 'wait' : 'ok')}
            onPress={() => undefined}
            testID="shared-sheet-sync"
          />
          <SheetDivider />
          {onSendCopy !== undefined && (
            <SheetRow
              icon={icon('export-variant')}
              label="Send a copy"
              trailing={chevron}
              onPress={onSendCopy}
              testID="shared-sheet-copy"
            />
          )}
          {f.isOwner ? (
            <SheetRow
              icon={icon('link-variant-off', theme.colors.error)}
              label="Stop sharing"
              onPress={onStop}
              testID="shared-sheet-stop"
            />
          ) : (
            <SheetRow
              icon={icon('logout', theme.colors.error)}
              label="Leave folder"
              onPress={onLeave}
              testID="shared-sheet-leave"
            />
          )}
        </>
      )}
    </LibrarySheet>
  );
}

/**
 * Leave a shared folder (#712, G10 mockup 10): Keep a copy (default) or
 * Remove it. A plain themed dialog over a scrim (never a Paper Portal).
 */
export function LeaveDialog({
  name,
  items,
  onLeave,
  onCancel,
}: {
  name: string | null;
  items: number;
  onLeave: (keepCopy: boolean) => void;
  onCancel: () => void;
}) {
  const [keep, setKeep] = useState(true);
  if (name === null) return null;
  return (
    <ThemedDialog
      title={`Leave ${name}?`}
      confirm="Leave"
      onConfirm={() => onLeave(keep)}
      onCancel={onCancel}
      testID="shared-leave-dialog"
    >
      <Choice
        on={keep}
        label="Keep a copy"
        detail="A normal folder on this phone"
        onPress={() => setKeep(true)}
        testID="shared-leave-keep"
      />
      <Choice
        on={!keep}
        label="Remove it"
        detail={items === 1 ? '1 item' : `${items} items`}
        onPress={() => setKeep(false)}
        testID="shared-leave-remove"
      />
    </ThemedDialog>
  );
}

/** Stop sharing (#712, G10 mockup 11): the owner closes the share; each phone keeps its folder. */
export function StopDialog({
  name,
  onStop,
  onCancel,
}: {
  name: string | null;
  onStop: () => void;
  onCancel: () => void;
}) {
  const t = useSchemeTokens();
  if (name === null) return null;
  return (
    <ThemedDialog
      title={`Stop sharing ${name}?`}
      confirm="Stop sharing"
      onConfirm={onStop}
      onCancel={onCancel}
      testID="shared-stop-dialog"
    >
      <Text style={[styles.body, { color: t.inkVariant }]}>
        Each person keeps the folder as a normal one.
      </Text>
    </ThemedDialog>
  );
}

function Choice({
  on,
  label,
  detail,
  onPress,
  testID,
}: {
  on: boolean;
  label: string;
  detail: string;
  onPress: () => void;
  testID: string;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      testID={testID}
      style={[styles.choice, on && { backgroundColor: theme.colors.secondaryContainer }]}
    >
      <Icon
        source={on ? 'radiobox-marked' : 'radiobox-blank'}
        size={24}
        color={on ? theme.colors.primary : t.inkMuted}
      />
      <View style={styles.choiceText}>
        <Text style={[styles.choiceLabel, { color: t.ink }]}>{label}</Text>
        <Text style={[sheetStyles.detail, { color: t.inkMuted }]}>{detail}</Text>
      </View>
    </Pressable>
  );
}

function ThemedDialog({
  title,
  confirm,
  onConfirm,
  onCancel,
  testID,
  children,
}: {
  title: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  testID: string;
  children: React.ReactNode;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <View style={StyleSheet.absoluteFill} testID={testID}>
      <Pressable
        style={[styles.scrim, { backgroundColor: theme.dark ? SCRIM_DARK : SCRIM_LIGHT }]}
        onPress={onCancel}
        accessibilityLabel="Cancel"
        accessibilityRole="button"
        importantForAccessibility="no"
      />
      <View
        style={[styles.dialog, { backgroundColor: theme.dark ? t.elevation.level2 : t.surface }]}
        accessibilityViewIsModal
      >
        <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
          {title}
        </Text>
        {children}
        <View style={styles.actions}>
          <Pressable onPress={onCancel} accessibilityRole="button" style={styles.action}>
            <Text style={[styles.actionLabel, { color: theme.colors.primary }]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={onConfirm}
            accessibilityRole="button"
            testID={`${testID}-confirm`}
            style={[styles.action, { backgroundColor: theme.colors.error }]}
          >
            <Text style={[styles.actionLabel, { color: theme.colors.onError }]}>{confirm}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const SCRIM_LIGHT = 'rgba(20,24,28,0.40)';
const SCRIM_DARK = 'rgba(0,0,0,0.55)';

const styles = StyleSheet.create({
  activity: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs },
  review: {
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  scrim: { ...StyleSheet.absoluteFill },
  dialog: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    top: '25%',
    borderRadius: 28,
    paddingTop: 22,
    paddingHorizontal: 20,
    paddingBottom: space.md,
    elevation: 12,
    shadowColor: palette.black,
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 16 },
  },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '800', marginBottom: space.sm },
  body: { fontSize: 14, lineHeight: 20, fontWeight: '600', marginBottom: space.md },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 52,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 14,
  },
  choiceText: { flex: 1, minWidth: 0 },
  choiceLabel: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: space.md,
  },
  action: {
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontSize: 15, fontWeight: '800' },
});
