/**
 * Settings → Extensions → Climbing crags (mockup 06):
 *
 * - not installed: what it is, and "Get" (the first crag download installs
 *   it by itself too, owner decision Q3-A);
 * - installed: the layer switch; "Show every crag" (streamed worldwide, off
 *   by default: only the saved crags draw); the grade system; the crags saved
 *   for offline with their sizes (open, update, delete); Check for updates;
 *   Coverage & sources; Remove (deletes the saved crags, their maps and
 *   attachments, after asking).
 */
import { coverageSummary } from '@core/climbing/coverage';
import { routesLabel } from '@core/climbing/card';
import { savedBytes, type SavedCrag } from '@core/climbing/saved';
import { formatBytes } from '@core/format';
import { fetchTopo } from '@data/climbing';
import { useClimbingStore } from '@state/climbingStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, List, Switch, Text, TouchableRipple, useTheme } from 'react-native-paper';

import { climbingActions } from './lazyActions';
import { cragHref } from './climbingRoutes';
import { CragBadge, useGradeSystem } from './ClimbingParts';

const GRADE_LABEL = { auto: 'Automatic', yds: 'YDS (5.10a)', french: 'French (6a)' } as const;
const NEXT_GRADE = { auto: 'yds', yds: 'french', french: 'auto' } as const;

function savedLine(c: SavedCrag): string {
  const date = new Date(c.savedAt).toLocaleDateString('en-CA', { month: 'short', year: 'numeric' });
  return `${routesLabel(c.routes)} · ${formatBytes(savedBytes(c))} · saved ${date}`;
}

export function ClimbingExtension() {
  const t = useSchemeTokens();
  const theme = useTheme();
  const router = useRouter();
  const installed = useSettingsStore((s) => s.climbingInstalledAt > 0);
  const show = useSettingsStore((s) => s.showClimbing);
  const showAll = useSettingsStore((s) => s.climbingShowAll);
  const gradeSetting = useSettingsStore((s) => s.climbingGradeSystem);
  const set = useSettingsStore((s) => s.set);
  const system = useGradeSystem();
  const saved = useClimbingStore((s) => s.saved);
  const coverage = useClimbingStore((s) => s.coverage);
  const downloads = useClimbingStore((s) => s.downloads);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [updates, setUpdates] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void useClimbingStore.getState().hydrate();
    void climbingActions().then(async (a) => {
      await a.refreshClimbingCoverage();
      await a.refreshCragPackSizes();
    });
  }, []);

  if (!installed) {
    return (
      <View style={styles.pad}>
        <View style={styles.getRow}>
          <CragBadge size={36} />
          <View style={styles.flex}>
            <Text variant="titleSmall">Climbing crags</Text>
            <Text variant="bodySmall" style={{ color: t.inkVariant }}>
              Crags worldwide on your map, with their routes and grades. Download a crag to keep its
              topo and approach map offline.
            </Text>
          </View>
          <Button
            mode="contained"
            compact
            icon="download"
            onPress={() => void climbingActions().then((a) => a.installClimbing())}
            accessibilityLabel="Get Climbing crags"
          >
            Get
          </Button>
        </View>
        <Text variant="bodySmall" style={[styles.note, { color: t.inkMuted }]}>
          Free · open data from OpenBeta, OpenStreetMap and camptocamp · a few MB per downloaded
          crag
        </Text>
      </View>
    );
  }

  const total = saved.reduce((n, c) => n + savedBytes(c), 0);
  const checkUpdates = async () => {
    setChecking(true);
    const out: string[] = [];
    for (const c of saved) {
      const topo = await fetchTopo(c.uid);
      if (topo?.from === 'network' && topo.detail.v !== c.version) out.push(c.uid);
    }
    setUpdates(out);
    setChecking(false);
  };
  const updateAll = async () => {
    const a = await climbingActions();
    for (const uid of updates ?? []) {
      await a.downloadCrag(uid, { withMap: false }).catch(() => undefined);
    }
    setUpdates([]);
  };
  const confirmDelete = (c: SavedCrag) =>
    Alert.alert(
      `Delete ${c.name}?`,
      'Its topo, its map and your attached topos leave this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void climbingActions().then((a) => a.removeCrag(c.uid)),
        },
      ],
    );
  const confirmRemove = () =>
    Alert.alert(
      'Remove Climbing crags?',
      saved.length > 0
        ? `The crags leave the map, and your ${saved.length} saved ${saved.length === 1 ? 'crag' : 'crags'} (${formatBytes(total)}) leave this phone, with your attached topos.`
        : 'The crags leave the map. You can get them again any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void climbingActions().then((a) => a.removeClimbing()),
        },
      ],
    );

  return (
    <List.Section>
      <List.Item
        title="Climbing crags"
        description={
          show ? 'On · Map overlays › Extensions' : 'Off · switch it on here or in Map overlays'
        }
        left={() => (
          <View style={styles.inlineBadge}>
            <CragBadge size={36} saved />
          </View>
        )}
        right={() => (
          <Switch
            value={show}
            onValueChange={(v) => set('showClimbing', v)}
            accessibilityLabel="Show climbing crags"
          />
        )}
      />
      <List.Item
        title="Show every crag"
        description={`${coverage ? `About ${coverage.crags.toLocaleString('en-US')} crags worldwide, streamed` : 'Every crag worldwide, streamed'} like the base map. Off: only the crags you saved.`}
        descriptionNumberOfLines={3}
        right={() => (
          <Switch
            value={showAll}
            onValueChange={(v) => set('climbingShowAll', v)}
            accessibilityLabel="Show every crag"
          />
        )}
      />
      <List.Item
        title="Grades"
        description={`${GRADE_LABEL[gradeSetting]}${gradeSetting === 'auto' ? ` · ${system === 'yds' ? 'YDS here' : 'French here'}` : ''}`}
        onPress={() => set('climbingGradeSystem', NEXT_GRADE[gradeSetting])}
        right={(p) => <List.Icon {...p} icon="swap-horizontal" />}
        accessibilityLabel={`Grades: ${GRADE_LABEL[gradeSetting]}. Tap to change`}
      />
      <List.Subheader>{`Saved for offline · ${saved.length}`}</List.Subheader>
      {saved.length === 0 && (
        <Text variant="bodySmall" style={[styles.pad, { color: t.inkMuted }]}>
          Download a crag from Explore › Climbing to keep its topo and map here.
        </Text>
      )}
      {saved.map((c) => (
        <List.Item
          key={c.uid}
          title={c.name}
          description={downloads[c.uid] ? 'Updating…' : savedLine(c)}
          onPress={() => router.push(cragHref(c.uid))}
          right={() => (
            <Pressable
              onPress={() => confirmDelete(c)}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${c.name}`}
              hitSlop={8}
              style={styles.iconButton}
            >
              <Icon source="delete-outline" size={22} color={t.inkVariant} />
            </Pressable>
          )}
        />
      ))}
      {saved.length > 0 && (
        <List.Item
          title="Check for updates"
          description={
            checking
              ? 'Checking…'
              : updates === null
                ? 'Route data refreshes monthly'
                : updates.length === 0
                  ? 'Every saved crag is up to date'
                  : `${updates.length} ${updates.length === 1 ? 'crag has' : 'crags have'} changes`
          }
          onPress={checking ? undefined : () => void checkUpdates()}
          right={() =>
            updates !== null && updates.length > 0 ? (
              <Button mode="contained" compact onPress={() => void updateAll()}>
                Update
              </Button>
            ) : null
          }
        />
      )}
      <List.Item
        title="Coverage & sources"
        description={coverageSummary(coverage)}
        descriptionNumberOfLines={2}
        onPress={() => setSourcesOpen((o) => !o)}
        right={(p) => <List.Icon {...p} icon={sourcesOpen ? 'chevron-up' : 'chevron-right'} />}
      />
      {sourcesOpen && (
        <View style={styles.sources}>
          {(coverage?.sources ?? []).map((s) => (
            <TouchableRipple
              key={s.key}
              onPress={() => void Linking.openURL(s.url)}
              accessibilityRole="link"
              accessibilityLabel={`${s.name}, ${s.licence}`}
            >
              <View style={styles.sourceRow}>
                <View style={styles.flex}>
                  <Text variant="bodyMedium">{s.name}</Text>
                  <Text variant="bodySmall" style={{ color: t.inkMuted }}>
                    {s.licence}
                  </Text>
                </View>
                <Text variant="labelMedium" style={{ color: t.inkVariant }}>
                  {`${s.crags.toLocaleString('en-US')} crags`}
                </Text>
              </View>
            </TouchableRipple>
          ))}
          <Text variant="bodySmall" style={[styles.note, { color: t.inkMuted }]}>
            Facts only: names, grades, styles and positions. Access status comes from partners when
            they agree; until then every crag reads “access unknown”. Wall diagrams are generated
            from OpenStreetMap route starts and are not to scale. Refreshed monthly.
          </Text>
        </View>
      )}
      <List.Item
        title="Remove extension"
        titleStyle={{ color: theme.colors.error }}
        description={
          saved.length > 0
            ? `Deletes ${saved.length} saved ${saved.length === 1 ? 'crag' : 'crags'} and frees ${formatBytes(total)}`
            : 'Hides the layer'
        }
        onPress={confirmRemove}
        accessibilityLabel="Remove Climbing crags extension"
      />
    </List.Section>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  getRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  flex: { flex: 1 },
  inlineBadge: { marginLeft: 8, justifyContent: 'center' },
  note: { marginTop: 8 },
  sources: { paddingHorizontal: 16, paddingBottom: 8, gap: 2 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  iconButton: { justifyContent: 'center', paddingHorizontal: 4 },
});
