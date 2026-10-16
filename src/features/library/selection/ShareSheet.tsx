import {
  linksNote,
  sendCopyLines,
  zipFileList,
  type ShareListLine,
  type SharePlan,
} from '@core/library/sharePlan';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { LibrarySheet, SheetRow, sheetStyles } from './LibrarySheet';

/**
 * The Share sheet (#711): one choice in 2.6.1, "Send a copy", which says
 * exactly what will go before the system share sheet opens: the file name,
 * what is inside and the size, then the contents of a zip. Catalog maps are
 * named as links, never files (their licence). For a folder or a single
 * item, "Share live" (#712) sits above it.
 */

const PLAN_ICON: Record<SharePlan['kind'], string> = {
  zip: 'folder-zip-outline',
  gpx: 'map-marker-path',
  pdf: 'file-pdf-box',
  waypoints: 'map-marker-multiple-outline',
  link: 'link-variant',
};

const LINE_ICON: Record<ShareListLine['icon'], string> = {
  pdf: 'file-pdf-box',
  gpx: 'map-marker-path',
  waypoints: 'map-marker-outline',
  links: 'link-variant',
};

export function ShareSheet({
  visible,
  focused,
  title,
  subtitle,
  plan,
  bytes,
  sizeNote,
  busy,
  onSend,
  onClose,
  live,
}: {
  visible: boolean;
  focused: boolean;
  title: string;
  subtitle: string;
  plan: SharePlan | null;
  bytes: number;
  /** Words after the size for one map ("georeferenced"). */
  sizeNote?: string;
  busy: boolean;
  onSend: () => void;
  onClose: () => void;
  /** "Share live" (#712), for a folder or a single item. */
  live?: { label: string; detail: string; onPress: () => void };
}) {
  const t = useSchemeTokens();
  if (plan === null) return null;
  const [what, meta] = sendCopyLines(plan, bytes);
  const metaLine = [meta, sizeNote].filter(Boolean).join(' · ');
  const list = plan.kind === 'zip' ? zipFileList(plan) : [];
  const note = plan.kind === 'zip' ? linksNote(plan.links) : null;
  return (
    <LibrarySheet
      visible={visible}
      focused={focused}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      testID="library-share-sheet"
    >
      {live !== undefined && (
        <SheetRow
          big
          accent
          icon={<Icon source="sync" size={26} color={t.ink} />}
          label={live.label}
          detail={
            <Text numberOfLines={2} style={[sheetStyles.detail, { color: t.inkMuted }]}>
              {live.detail}
            </Text>
          }
          trailing={<Icon source="chevron-right" size={24} color={t.inkMuted} />}
          onPress={live.onPress}
          testID="library-share-live"
        />
      )}
      <SheetRow
        big
        accent={live === undefined}
        icon={<Icon source={PLAN_ICON[plan.kind]} size={26} color={t.ink} />}
        label="Send a copy"
        detail={
          <>
            <Text numberOfLines={1} style={[sheetStyles.detail, { color: t.inkMuted }]}>
              {what}
            </Text>
            {metaLine !== '' && (
              <Text numberOfLines={1} style={[sheetStyles.detail, { color: t.inkMuted }]}>
                {metaLine}
              </Text>
            )}
          </>
        }
        trailing={
          busy ? (
            <ActivityIndicator color={t.ink} accessibilityLabel="Preparing the copy" />
          ) : (
            <Icon source="chevron-right" size={24} color={t.inkMuted} />
          )
        }
        onPress={() => {
          if (!busy) onSend();
        }}
        accessibilityLabel={`Send a copy: ${what}${metaLine ? `, ${metaLine}` : ''}`}
        testID="library-share-send"
      />
      {list.length > 0 && (
        <View style={styles.files}>
          {list.map((line, i) => (
            <View key={`${line.label}-${i}`} style={styles.fileLine}>
              <Icon source={LINE_ICON[line.icon]} size={15} color={t.inkMuted} />
              <Text numberOfLines={1} style={[styles.fileLabel, { color: t.inkMuted }]}>
                {line.label}
              </Text>
            </View>
          ))}
        </View>
      )}
      {note !== null && (
        <View style={[styles.note, { backgroundColor: t.surfaceVariant }]}>
          <Icon source="link-variant" size={20} color={t.ink} />
          <Text style={[styles.noteText, { color: t.inkVariant }]}>{note}</Text>
        </View>
      )}
    </LibrarySheet>
  );
}

const styles = StyleSheet.create({
  files: { marginLeft: 82, marginRight: 20, gap: 2 },
  fileLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 18 },
  fileLabel: { flexShrink: 1, fontSize: 12.5, lineHeight: 18, fontWeight: '600' },
  note: {
    flexDirection: 'row',
    gap: space.md,
    marginTop: 6,
    marginHorizontal: space.lg,
    paddingVertical: 10,
    paddingHorizontal: space.md,
    borderRadius: 14,
  },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600' },
});
