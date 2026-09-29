import { sourceLabel, tracksFromSource } from '@core/import/origin';
import { canImport, canUpload } from '@core/strava/tokens';
import {
  healthAvailability,
  healthSource,
  openHealthInstall,
  requestHealthPermissions,
  type HealthAvailability,
} from '@lib/health';
import { connectStrava, disconnectStrava, isStravaConfigured } from '@lib/strava';
import { useImportStore, type ImportSheetSource } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useStravaStore } from '@state/stravaStore';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Icon, List, Switch, Text } from 'react-native-paper';

import { dismissImportJob, stopSourceImport } from '../import/importController';
import { Card, SourceTile, type SourceTileKind } from '../import/importParts';

/**
 * Settings › Connections (#432/#435, board `Main`): Strava (connect,
 * scopes, import, automatic import, disconnect — optionally deleting what
 * came from it, as Strava's API agreement requires that to be possible),
 * Apple Health / Health Connect access, how to get Garmin activities in
 * through Strava, and importing files. The OAuth round-trip and tokens live
 * in `@lib/strava` / `@state/stravaStore`; imports in `features/import`.
 */

function CardHead({
  kind,
  title,
  children,
}: {
  kind: SourceTileKind;
  title: string;
  children?: ReactNode;
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.head}>
      <SourceTile kind={kind} />
      <View style={styles.headText}>
        <Text style={[styles.cardTitle, { color: t.ink }]}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

function Line({ children, muted = true }: { children: ReactNode; muted?: boolean }) {
  const t = useSchemeTokens();
  return (
    <Text style={[styles.line, { color: muted ? t.inkMuted : t.inkVariant }]}>{children}</Text>
  );
}

/** The card's bottom bar: one or two text buttons split by a hairline. */
function Actions({
  items,
}: {
  items: { label: string; onPress: () => void; strong?: boolean; disabled?: boolean }[];
}) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.actions, { borderTopColor: t.divider }]}>
      {items.map((item, i) => (
        <View key={item.label} style={styles.actionCell}>
          {i > 0 && <View style={[styles.actionSplit, { backgroundColor: t.divider }]} />}
          <Pressable
            onPress={item.onPress}
            disabled={item.disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled: !!item.disabled }}
            style={({ pressed }) => [styles.action, (pressed || item.disabled) && styles.pressed]}
          >
            <Text
              style={[
                styles.actionLabel,
                item.strong
                  ? { color: t.inkVariant, fontWeight: '700' }
                  : { color: t.inkMuted, fontWeight: '600' },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function Pill({ label }: { label: string }) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.pill, { backgroundColor: t.library.onMap }]}>
      <Text style={[styles.pillLabel, { color: t.library.onMapInk }]}>{label}</Text>
    </View>
  );
}

function StravaCard({
  showSnack,
  openImport,
}: {
  showSnack: (message: string) => void;
  openImport: (source: ImportSheetSource) => void;
}) {
  const t = useSchemeTokens();
  const connection = useStravaStore((s) => s.connection);
  const tracks = useLibraryStore((s) => s.tracks);
  const removeTracks = useLibraryStore((s) => s.removeTracks);
  const autoImport = useImportStore((s) => s.autoImportStrava);
  const setAutoImport = useImportStore((s) => s.setAutoImportStrava);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [alsoDelete, setAlsoDelete] = useState(false);
  const configured = isStravaConfigured();
  const reads = canImport(connection);
  const writes = canUpload(connection);
  const imported = tracksFromSource(tracks, 'strava');
  const deleteLabel = `Also delete ${imported.length} trail${imported.length === 1 ? '' : 's'} imported from Strava`;

  const onConnect = () => {
    if (busy) return;
    setBusy(true);
    connectStrava()
      .then((outcome) =>
        showSnack(
          outcome.ok
            ? `Connected to Strava${outcome.athleteName ? ` as ${outcome.athleteName}` : ''}`
            : outcome.message,
        ),
      )
      .catch(() => showSnack('Could not connect to Strava'))
      .finally(() => setBusy(false));
  };

  const onDisconnect = () => {
    if (busy) return;
    setBusy(true);
    const deleteIds = alsoDelete ? imported.map((x) => x.id) : [];
    // A Strava import can't go on without the connection.
    if (useImportStore.getState().job?.source === 'strava') stopSourceImport();
    disconnectStrava()
      .then(({ revoked }) => {
        if (deleteIds.length > 0) {
          removeTracks(deleteIds);
          useImportStore.getState().forgetSource('strava');
          dismissImportJob();
        }
        const deleted =
          deleteIds.length > 0
            ? ` · ${deleteIds.length} trail${deleteIds.length === 1 ? '' : 's'} deleted`
            : '';
        showSnack(
          revoked
            ? `Disconnected from Strava${deleted}`
            : `Disconnected${deleted} — revoke Inukshuk at strava.com/settings/apps if it still appears`,
        );
      })
      .catch(() => showSnack('Disconnected from Strava'))
      .finally(() => {
        setBusy(false);
        setConfirming(false);
        setAlsoDelete(false);
      });
  };

  let status: string;
  if (!configured) status = 'Strava is not configured in this build';
  else if (!connection) status = 'Import your activities and push saved trails to Strava';
  else status = connection.athleteName ? `Connected as ${connection.athleteName}` : 'Connected';

  return (
    <Card style={styles.card}>
      <CardHead kind="strava" title="Strava">
        <Line>{status}</Line>
        {connection && (reads || writes) && (
          <View style={styles.pills}>
            {reads && <Pill label="Import" />}
            {writes && <Pill label="Upload" />}
          </View>
        )}
        {busy && <ActivityIndicator size="small" color={t.ink} style={styles.spinner} />}
      </CardHead>

      {connection && reads && !confirming && (
        <View style={[styles.switchRow, { borderTopColor: t.divider }]}>
          <View style={styles.headText}>
            <Text style={[styles.switchTitle, { color: t.ink }]}>
              Import new activities automatically
            </Text>
            <Line>When you open Inukshuk, at most every 15 minutes</Line>
          </View>
          <Switch
            value={autoImport}
            onValueChange={setAutoImport}
            accessibilityLabel="Import new activities automatically"
          />
        </View>
      )}

      {confirming ? (
        <View style={[styles.confirm, { borderTopColor: t.divider }]}>
          <View style={styles.confirmBody}>
            <Text style={[styles.confirmTitle, { color: t.ink }]}>Disconnect Strava?</Text>
            <Line>
              Inukshuk stops importing from Strava and uploading to it. Trails already here stay
              unless you delete them.
            </Line>
            {imported.length > 0 && (
              <Pressable
                onPress={() => setAlsoDelete((v) => !v)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: alsoDelete }}
                accessibilityLabel={deleteLabel}
                style={styles.checkRow}
              >
                <Icon
                  source={alsoDelete ? 'checkbox-marked' : 'checkbox-blank-outline'}
                  size={24}
                  color={alsoDelete ? t.ink : t.inkMuted}
                />
                <Text style={[styles.checkLabel, { color: t.ink }]}>{deleteLabel}</Text>
              </Pressable>
            )}
          </View>
          <Actions
            items={[
              {
                label: 'Cancel',
                onPress: () => {
                  setConfirming(false);
                  setAlsoDelete(false);
                },
              },
              { label: 'Disconnect', onPress: onDisconnect, strong: true, disabled: busy },
            ]}
          />
        </View>
      ) : connection ? (
        <Actions
          items={[
            reads
              ? { label: 'Import activities', onPress: () => openImport('strava'), strong: true }
              : { label: 'Allow importing', onPress: onConnect, strong: true, disabled: busy },
            { label: 'Disconnect', onPress: () => setConfirming(true), disabled: busy },
          ]}
        />
      ) : (
        <Actions
          items={[
            {
              label: 'Connect Strava',
              onPress: onConnect,
              strong: true,
              disabled: !configured || busy,
            },
          ]}
        />
      )}
    </Card>
  );
}

function HealthCard({ openImport }: { openImport: (source: ImportSheetSource) => void }) {
  const health = healthSource();
  const allowed = useImportStore((s) => s.healthAllowed);
  const setAllowed = useImportStore((s) => s.setHealthAllowed);
  const [availability, setAvailability] = useState<HealthAvailability | 'checking'>(
    health ? 'checking' : 'unavailable',
  );
  const [asking, setAsking] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    if (!health) return;
    let live = true;
    healthAvailability()
      .then((a) => {
        if (live) setAvailability(a);
      })
      .catch(() => {
        if (live) setAvailability('unavailable');
      });
    return () => {
      live = false;
    };
  }, [health]);

  if (!health || availability === 'unavailable' || availability === 'checking') return null;
  const id = health.id === 'health-connect' ? 'health-connect' : 'apple-health';
  const label = sourceLabel(id);

  const onAllow = () => {
    if (asking) return;
    setAsking(true);
    requestHealthPermissions()
      .then((outcome) => {
        setDeclined(outcome === 'denied');
        if (outcome !== 'denied') setAllowed(true);
      })
      .catch(() => setDeclined(true))
      .finally(() => setAsking(false));
  };

  let status: string;
  let action: { label: string; onPress: () => void; strong?: boolean; disabled?: boolean };
  if (availability === 'needs-install') {
    status = 'Health Connect isn’t installed on this phone yet';
    action = {
      label: 'Install Health Connect',
      onPress: () => void openHealthInstall(),
      strong: true,
    };
  } else if (allowed) {
    status = 'Allowed';
    action = { label: 'Import activities', onPress: () => openImport(id), strong: true };
  } else {
    status = declined ? `Not allowed — turn it on in ${label}` : 'Not allowed yet';
    action = { label: 'Allow', onPress: onAllow, strong: true, disabled: asking };
  }

  return (
    <Card style={styles.card}>
      <CardHead kind={id} title={label}>
        <Line>{status}</Line>
        <Line>
          {id === 'apple-health'
            ? 'Workouts with routes from your Apple Watch and apps that save to Health. Read only.'
            : 'Workouts with routes from apps that save to Health Connect. Read only.'}
        </Line>
      </CardHead>
      <Actions items={[action]} />
    </Card>
  );
}

const GARMIN_STEPS = [
  'Open the Garmin Connect app.',
  'Tap More, then Settings › Connected Apps.',
  'Choose Strava and tap Connect.',
  'Your watch activities now reach Strava — import them from Strava here.',
];

function GarminCard() {
  const t = useSchemeTokens();
  const [open, setOpen] = useState(false);
  return (
    <Card style={styles.card}>
      <CardHead kind="garmin" title="Garmin Connect">
        <Line>
          Turn on Garmin → Strava sync in the Garmin Connect app: your watch activities then arrive
          with your Strava import.
        </Line>
      </CardHead>
      {open && (
        <View style={[styles.steps, { borderTopColor: t.divider }]}>
          {GARMIN_STEPS.map((step, i) => (
            <View key={step} style={styles.step}>
              <Text style={[styles.stepNumber, { color: t.inkMuted }]}>{`${i + 1}.`}</Text>
              <Text style={[styles.stepText, { color: t.inkVariant }]}>{step}</Text>
            </View>
          ))}
        </View>
      )}
      <Actions
        items={[
          {
            label: open ? 'Hide the steps' : 'How to link Garmin to Strava',
            onPress: () => setOpen((v) => !v),
            strong: true,
          },
        ]}
      />
    </Card>
  );
}

function FilesRow({ onPress }: { onPress: () => void }) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="From files: FIT, GPX, TCX, or a Strava or Garmin export zip"
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      <Card style={styles.card}>
        <View style={[styles.head, styles.filesRow]}>
          <SourceTile kind="files" />
          <View style={styles.headText}>
            <Text style={[styles.cardTitle, { color: t.ink }]}>From files</Text>
            <Line>FIT, GPX, TCX, or a Strava / Garmin export zip. No account needed.</Line>
          </View>
          <Icon source="chevron-right" size={22} color={t.inkMuted} />
        </View>
      </Card>
    </Pressable>
  );
}

export function ConnectionsSection({ showSnack }: { showSnack: (message: string) => void }) {
  const t = useSchemeTokens();
  const router = useRouter();
  const requestSheet = useImportStore((s) => s.requestSheet);
  const connected = useStravaStore((s) => s.connection !== null);
  const uploads = useStravaStore((s) => canUpload(s.connection));

  // The sheet lives on the Library: ask for it there, then go.
  const openImport = (source: ImportSheetSource) => {
    requestSheet(source);
    router.navigate('/library');
  };

  return (
    <List.Section>
      <List.Subheader>Connections</List.Subheader>
      <Text style={[styles.intro, { color: t.inkMuted }]}>
        Bring your activities into Inukshuk, and send your trails back out.
      </Text>
      <StravaCard showSnack={showSnack} openImport={openImport} />
      <HealthCard openImport={openImport} />
      <GarminCard />
      <FilesRow onPress={() => openImport('files')} />
      <Text style={[styles.note, { color: t.inkMuted }]}>
        Imported activities stay on this phone. Nothing is sent to Strava or Garmin unless you
        choose to upload a trail.
        {connected && uploads
          ? ' After you save a recording, Inukshuk offers to push it to Strava; older trails can be sent from the Library’s ⋮ menu.'
          : ''}
      </Text>
    </List.Section>
  );
}

const styles = StyleSheet.create({
  intro: { marginHorizontal: space.lg, marginBottom: space.md, fontSize: 15, lineHeight: 21 },
  card: { marginHorizontal: space.lg, marginBottom: 14 },
  head: { flexDirection: 'row', gap: 14, alignItems: 'flex-start', padding: space.lg },
  headText: { flex: 1, gap: space.xs },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  line: { fontSize: 14, lineHeight: 20 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: space.xs },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: space.xs },
  pillLabel: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  spinner: { alignSelf: 'flex-start', marginTop: space.xs },
  actions: { flexDirection: 'row', borderTopWidth: 1 },
  actionCell: { flex: 1, flexDirection: 'row' },
  actionSplit: { width: 1 },
  action: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  actionLabel: { fontSize: 15, lineHeight: 20, textAlign: 'center' },
  pressed: { opacity: 0.6 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderTopWidth: 1,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: target.min,
  },
  switchTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  confirm: { borderTopWidth: 1, paddingTop: space.lg },
  confirmBody: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm },
  confirmTitle: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: target.min },
  checkLabel: { flex: 1, fontSize: 15, lineHeight: 20 },
  steps: { borderTopWidth: 1, padding: space.lg, gap: space.sm },
  step: { flexDirection: 'row', gap: space.sm },
  stepNumber: { fontSize: 14, lineHeight: 20, fontWeight: '700', minWidth: 18 },
  stepText: { flex: 1, fontSize: 14, lineHeight: 20 },
  filesRow: { alignItems: 'center' },
  note: {
    marginHorizontal: space.xl,
    marginTop: space.xs,
    marginBottom: space.sm,
    fontSize: 13,
    lineHeight: 19,
  },
});
