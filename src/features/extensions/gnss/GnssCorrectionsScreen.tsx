import { CASTER_PRESETS, frameLabel, presetById, type CorrectionFrame } from '@core/gnss/casters';
import { activeProfile, newProfile, profileProblem, type NtripProfile } from '@core/gnss/config';
import { rankMountpoints, type RankedStream } from '@core/gnss/sourcetable';
import { gnssSecrets } from '@data/gnss/credentials';
import { ntripSocketFactory } from '@data/gnss/ntripSocket';
import { newId } from '@data/storage';
import { fetchSourcetable } from '@features/gnss/ntripClient';
import { useGnssStore } from '@state/gnssStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Chip,
  Icon,
  RadioButton,
  SegmentedButtons,
  Switch,
  Text,
  TextInput,
} from 'react-native-paper';

import { GnssScreenFrame, SectionLabel } from './GnssScreenFrame';

/**
 * The frames a caster's corrections can be declared in — the ones Convert
 * plans from. `null` = unknown (WGS 84 assumed with ⚠, owner A5).
 */
export const CASTER_FRAMES: readonly { id: string; frame: CorrectionFrame | null }[] = [
  { id: 'unknown', frame: null },
  { id: 'csrs-1997', frame: { frame: 'csrs', epoch: 1997 } },
  { id: 'csrs-2002', frame: { frame: 'csrs', epoch: 2002 } },
  { id: 'csrs-2010', frame: { frame: 'csrs', epoch: 2010 } },
  { id: 'itrf2020-obs', frame: { frame: 'itrf2020', epoch: 'observation' } },
  { id: 'itrf2014-obs', frame: { frame: 'itrf2014', epoch: 'observation' } },
  { id: 'nad83-2011', frame: { frame: 'nad83-2011' } },
  { id: 'wgs84', frame: { frame: 'wgs84' } },
];

export function casterFrameId(f: CorrectionFrame | null): string {
  if (f === null) return 'unknown';
  const hit = CASTER_FRAMES.find(
    (c) => c.frame !== null && c.frame.frame === f.frame && c.frame.epoch === f.epoch,
  );
  return hit?.id ?? 'unknown';
}

function mountLine(r: RankedStream): string {
  const parts = [r.stream.format];
  if (r.stream.navSystem) parts.push(r.stream.navSystem);
  if (r.distanceKm !== null) parts.push(`${r.distanceKm.toFixed(0)} km`);
  if (r.stream.networkSolution) parts.push('network (VRS)');
  if (!r.usable) parts.push('not RTCM 3 — not usable');
  return parts.join(' · ');
}

/**
 * Settings › External GNSS receiver › RTK corrections (mockup `gnss-ntrip`):
 * a caster (preset or custom), its credentials (the password goes to the
 * secret store, never `gnss.json`), the mountpoint from the caster's
 * sourcetable nearest first, the consent to send the rover's position, and
 * — what decides the coordinates — the frame and epoch of the caster's
 * corrections.
 */
export function GnssCorrectionsScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const config = useGnssStore((s) => s.config);
  const hydrated = useGnssStore((s) => s.hydrated);
  const upsert = useGnssStore((s) => s.upsertProfile);
  const removeProfile = useGnssStore((s) => s.removeProfile);
  const update = useGnssStore((s) => s.updateConfig);
  const fix = useGnssStore((s) => s.fix);
  const lastKnown = useSettingsStore((s) => s.lastKnownPosition);

  const [draft, setDraft] = useState<NtripProfile>(
    () => activeProfile(config) ?? config.profiles[0] ?? newProfile(newId(), 'rtk2go'),
  );
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mounts, setMounts] = useState<RankedStream[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) void useGnssStore.getState().hydrate();
  }, [hydrated]);

  useEffect(() => {
    let alive = true;
    void gnssSecrets.get(draft.id).then((p) => alive && setPassword(p ?? ''));
    return () => {
      alive = false;
    };
  }, [draft.id]);

  const set = (patch: Partial<NtripProfile>) => setDraft((d) => ({ ...d, ...patch }));

  const choosePreset = (presetId: string | null) => {
    const fresh = newProfile(draft.id, presetId);
    setDraft({ ...fresh, username: draft.username, ggaConsent: draft.ggaConsent });
    setMounts(null);
    setMountError(null);
  };

  const here = fix
    ? { lat: fix.lat, lon: fix.lon }
    : lastKnown
      ? { lat: lastKnown.latitude, lon: lastKnown.longitude }
      : null;

  const loadMounts = async () => {
    setLoading(true);
    setMountError(null);
    try {
      const table = await fetchSourcetable(ntripSocketFactory(), draft, password);
      setMounts(
        here
          ? rankMountpoints(table.streams, here.lat, here.lon, 30)
          : table.streams.slice(0, 30).map((s) => ({ stream: s, distanceKm: null, usable: true })),
      );
    } catch (e) {
      setMountError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const chooseMount = (r: RankedStream) =>
    set({
      mountpoint: r.stream.mountpoint,
      needsGga: r.stream.nmea,
      baseLat: r.stream.lat,
      baseLon: r.stream.lon,
      label: `${presetById(draft.presetId ?? '')?.label.split(' (')[0] ?? draft.host} · ${r.stream.mountpoint}`,
    });

  const problem = profileProblem(draft);
  const preset = draft.presetId ? presetById(draft.presetId) : undefined;

  const save = async () => {
    if (problem !== null) {
      setSaveError(problem);
      return;
    }
    const profile: NtripProfile = {
      ...draft,
      host: draft.host.trim(),
      mountpoint: draft.mountpoint.trim(),
      label:
        draft.label.trim() === ''
          ? `${draft.host.trim()} · ${draft.mountpoint.trim()}`
          : draft.label,
    };
    await gnssSecrets.set(profile.id, password);
    upsert(profile);
    update({ activeProfileId: profile.id });
    router.back();
  };

  const stopCorrections = () => {
    update({ activeProfileId: null });
    router.back();
  };

  const deleteProfile = async () => {
    await gnssSecrets.remove(draft.id);
    removeProfile(draft.id);
    router.back();
  };

  const frameId = casterFrameId(draft.frame);
  const frameOptions = useMemo(
    () =>
      CASTER_FRAMES.map((c) => ({
        id: c.id,
        label: c.frame === null ? 'Unknown — WGS 84 assumed' : frameLabel(c.frame),
      })),
    [],
  );
  const saved = config.profiles.some((p) => p.id === draft.id);
  const isActive = config.activeProfileId === draft.id;

  return (
    <GnssScreenFrame
      title="RTK corrections"
      testID="gnss-corrections-screen"
      footer={
        <>
          {isActive ? (
            <Button onPress={stopCorrections}>Stop corrections</Button>
          ) : saved ? (
            <Button onPress={() => void deleteProfile()} textColor={t.status.gpsLostInk}>
              Delete
            </Button>
          ) : null}
          <Button mode="contained" onPress={() => void save()} accessibilityLabel="Save and use">
            Save and use
          </Button>
        </>
      }
    >
      {config.profiles.length > 1 && (
        <>
          <SectionLabel>Your casters</SectionLabel>
          <View style={styles.chips}>
            {config.profiles.map((p) => (
              <Chip
                key={p.id}
                mode="outlined"
                selected={p.id === draft.id}
                onPress={() => {
                  setDraft(p);
                  setMounts(null);
                }}
              >
                {p.label}
              </Chip>
            ))}
            <Chip
              mode="outlined"
              icon="plus"
              onPress={() => setDraft(newProfile(newId(), 'rtk2go'))}
            >
              New
            </Chip>
          </View>
        </>
      )}

      <View style={styles.chips}>
        {CASTER_PRESETS.map((p) => (
          <Chip
            key={p.id}
            mode="outlined"
            selected={draft.presetId === p.id}
            showSelectedCheck
            onPress={() => choosePreset(p.id)}
          >
            {p.label.split(' (')[0]}
          </Chip>
        ))}
        <Chip
          mode="outlined"
          selected={draft.presetId === null}
          showSelectedCheck
          onPress={() => choosePreset(null)}
        >
          Other caster
        </Chip>
      </View>
      {preset && (
        <Text variant="bodySmall" style={{ color: t.inkVariant }}>
          {preset.note}
        </Text>
      )}

      <TextInput
        mode="outlined"
        returnKeyType="done"
        label="Caster"
        value={draft.host}
        onChangeText={(host) => set({ host })}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        testID="gnss-caster-host"
      />
      <View style={styles.pair}>
        <TextInput
          mode="outlined"
          returnKeyType="done"
          label="Port"
          value={String(draft.port)}
          onChangeText={(v) => set({ port: Number(v.replace(/\D/g, '')) || 0 })}
          keyboardType="number-pad"
          style={styles.flex}
        />
        <SegmentedButtons
          style={styles.flex}
          value={String(draft.version)}
          onValueChange={(v) => set({ version: v === '1' ? 1 : 2 })}
          buttons={[
            { value: '1', label: 'NTRIP 1' },
            { value: '2', label: 'NTRIP 2' },
          ]}
        />
      </View>
      <View style={styles.pair}>
        <TextInput
          mode="outlined"
          returnKeyType="done"
          label="User"
          testID="gnss-user"
          value={draft.username}
          onChangeText={(username) => set({ username })}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.flex}
        />
        <TextInput
          mode="outlined"
          returnKeyType="done"
          label="Password"
          testID="gnss-password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.flex}
          right={
            <TextInput.Icon
              icon={showPassword ? 'eye-off' : 'eye'}
              onPress={() => setShowPassword((v) => !v)}
              accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
            />
          }
        />
      </View>

      <SectionLabel>Mountpoint · nearest first</SectionLabel>
      <View style={styles.pair}>
        <TextInput
          mode="outlined"
          returnKeyType="done"
          label="Mountpoint"
          testID="gnss-mountpoint"
          value={draft.mountpoint}
          onChangeText={(mountpoint) => set({ mountpoint })}
          autoCapitalize="characters"
          autoCorrect={false}
          style={styles.flex}
        />
        <Button
          mode="outlined"
          onPress={() => void loadMounts()}
          disabled={loading || draft.host.trim() === ''}
          style={styles.loadButton}
          accessibilityLabel="Browse mountpoints"
        >
          Browse
        </Button>
      </View>
      {loading && <ActivityIndicator />}
      {mountError !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {mountError}
        </Text>
      )}
      {mounts !== null && (
        <RadioButton.Group value={draft.mountpoint} onValueChange={() => undefined}>
          {mounts.map((r) => (
            <Pressable
              key={r.stream.mountpoint}
              onPress={() => r.usable && chooseMount(r)}
              disabled={!r.usable}
              accessibilityRole="radio"
              accessibilityState={{
                selected: r.stream.mountpoint === draft.mountpoint,
                disabled: !r.usable,
              }}
              accessibilityLabel={r.stream.mountpoint}
              style={[styles.mount, !r.usable && styles.dim]}
            >
              <RadioButton
                value={r.stream.mountpoint}
                disabled={!r.usable}
                onPress={() => chooseMount(r)}
              />
              <View style={styles.flex}>
                <Text variant="titleSmall">{r.stream.mountpoint}</Text>
                <Text variant="bodySmall" style={{ color: t.inkVariant }}>
                  {mountLine(r)}
                </Text>
              </View>
            </Pressable>
          ))}
        </RadioButton.Group>
      )}

      <View style={styles.switchRow}>
        <View style={styles.flex}>
          <Text variant="titleSmall">Send my position to the caster</Text>
          <Text
            variant="bodySmall"
            style={{ color: draft.needsGga && !draft.ggaConsent ? t.status.gpsWeak : t.inkVariant }}
          >
            {draft.needsGga
              ? draft.ggaConsent
                ? 'This mountpoint needs it · your position goes to the caster every 10 s'
                : 'This network mountpoint needs your position to send corrections'
              : 'Only network (VRS) mountpoints need it · never sent otherwise'}
          </Text>
        </View>
        <Switch
          value={draft.ggaConsent}
          onValueChange={(ggaConsent) => set({ ggaConsent })}
          accessibilityLabel="Send my position to the caster"
        />
      </View>

      <SectionLabel>Coordinates of this caster</SectionLabel>
      <RadioButton.Group
        value={frameId}
        onValueChange={(id) =>
          set({ frame: CASTER_FRAMES.find((c) => c.id === id)?.frame ?? null })
        }
      >
        {frameOptions.map((o) => (
          <RadioButton.Item
            key={o.id}
            value={o.id}
            label={o.label}
            mode="android"
            position="leading"
            labelStyle={styles.radioLabel}
            style={styles.radioItem}
          />
        ))}
      </RadioButton.Group>
      {draft.frame === null && (
        <View style={[styles.warn, { backgroundColor: t.surfaceVariant }]}>
          <Icon source="alert-outline" size={18} color={t.status.gpsWeak} />
          <Text variant="bodySmall" style={[styles.flex, { color: t.status.gpsWeak }]}>
            {`${preset ? preset.label.split(' (')[0] : 'This caster'} doesn’t say which datum its bases use — ask the base owner. Wrong here puts you about 1.5 m off in Canada, even when the chip says ±2 cm. Until then the coordinates are shown as WGS 84, marked “frame unknown”.`}
          </Text>
        </View>
      )}
      {saveError !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {saveError}
        </Text>
      )}
    </GnssScreenFrame>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pair: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  loadButton: { alignSelf: 'center' },
  mount: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 56 },
  dim: { opacity: 0.5 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  radioItem: { paddingVertical: 2, paddingHorizontal: 0 },
  radioLabel: { textAlign: 'left' },
  warn: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12 },
});
