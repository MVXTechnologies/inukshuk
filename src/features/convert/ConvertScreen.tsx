import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { plan as makePlan, resolveHeight } from '@core/convert/graph';
import { packsForGrids, type Pack } from '@core/convert/packs';
import { coordinateSections, heightSections } from '@core/convert/picker';
import {
  defaultTarget,
  emptyRequest,
  fromParams,
  toParams,
  type ConvertRequest,
} from '@core/convert/prefill';
import { evaluate } from '@core/convert/session';
import { CSRS_REALISATION } from '@core/convert/steps';
import { coordSystem, FRAMES } from '@core/convert/systems';
import type { ConvertSpec } from '@core/convert/types';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { useConvertStore } from '@state/convertStore';
import { useMapAimStore } from '@state/mapAimStore';
import { HeaderAction } from '@ui/components/ScreenHeader';
import { palette, radius, space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { Button, Icon, IconButton, Snackbar, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccuracyPanel } from './AccuracyPanel';
import { SystemPicker, type PickerTab } from './SystemPicker';
import { useConvertEnv } from './useConvertEnv';

/** Québec City: where an empty Convert starts when nothing better is known. */
const DEFAULT_NEAR = { lat: 46.8131, lon: -71.2075 };

function coordTitle(id: string): { title: string; subtitle: string; icon: string } {
  const c = coordSystem(id);
  if (!c) return { title: id, subtitle: '', icon: 'earth' };
  const f = FRAMES[c.frame];
  const title = c.kind === 'geographic' ? `${f.name} · geographic` : `${f.name} / ${c.name}`;
  const subtitle = [c.epsg ? `EPSG:${c.epsg}` : null, f.dynamic ? 'coordinate epoch' : f.note]
    .filter(Boolean)
    .join(' · ');
  return {
    title,
    subtitle,
    icon: c.kind === 'geographic' ? 'earth' : c.kind === 'geocentric' ? 'axis-arrow' : 'grid',
  };
}

function heightTitle(id: string | null, req: ConvertRequest): { title: string; subtitle: string } {
  if (id === null) return { title: 'No height', subtitle: 'Horizontal position only' };
  const h = resolveHeight(id, { stations: req.stations ?? [] });
  if (!h) return { title: id, subtitle: '' };
  if (h.kind === 'ellipsoidal')
    return { title: 'Ellipsoidal height', subtitle: 'h · same frame as the coordinates' };
  return { title: h.name, subtitle: `${h.note}${h.epsg ? ` · EPSG:${h.epsg}` : ''}` };
}

/**
 * Convert (mockups 08–10): FROM (system, coordinates, height, epoch) → TO
 * (system, height) with the results, each with its copy button, and the
 * accuracy panel. Every conversion is a pinned, validated pipeline
 * (`@core/convert/graph`); anything else is refused in red, never guessed.
 */
export function ConvertScreen({ params }: { params: Record<string, unknown> }) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { env, native, index, downloading, downloadError, download } = useConvertEnv();
  const record = useConvertStore((s) => s.record);
  const history = useConvertStore((s) => s.history);
  const hydrate = useConvertStore((s) => s.hydrate);
  const aim = useMapAimStore((s) => s.request);
  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(2500);

  const initial = useMemo<ConvertRequest>(
    () => fromParams(params) ?? emptyRequest(DEFAULT_NEAR),
    // Route params are read once: the screen owns the request afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [req, setReq] = useState<ConvertRequest>(initial);
  const [picker, setPicker] = useState<{ role: 'from' | 'to'; tab: PickerTab } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const ev = useMemo(() => evaluate(req, env), [req, env]);
  const near =
    ev.sourcePoint && Number.isFinite(ev.sourcePoint.lon)
      ? { lon: ev.sourcePoint.lon, lat: ev.sourcePoint.lat }
      : req.near;

  // Remember the last good conversion when leaving the screen.
  const lastOk = useRef<{ req: ConvertRequest; title: string } | null>(null);
  useEffect(() => {
    if (ev.status === 'ok') {
      lastOk.current = {
        req,
        title: `${coordTitle(req.spec.from).title} → ${req.spec.to === 'same' ? 'heights' : coordTitle(req.spec.to).title}${req.origin ? ` · ${req.origin.label.replace(/^From /, '')}` : ''}`,
      };
    }
  }, [ev.status, req]);
  useEffect(
    () => () => {
      const l = lastOk.current;
      if (l) record({ at: Date.now(), title: l.title, params: toParams(l.req) });
    },
    [record],
  );

  const from = coordSystem(req.spec.from);
  const toSys = req.spec.to === 'same' ? null : coordSystem(req.spec.to);
  const fromFrame = from ? FRAMES[from.frame] : null;
  const toFrame = toSys ? FRAMES[toSys.frame] : fromFrame;

  const update = (patch: Partial<ConvertRequest>) =>
    setReq((r) => {
      const next = { ...r, ...patch };
      // Typed coordinates are the user's, no longer the mark's approximate ones.
      if ('a' in patch || 'b' in patch || 'c' in patch) delete next.approxPosition;
      return next;
    });
  const updateSpec = (patch: Partial<ConvertSpec>) =>
    setReq((r) => ({ ...r, spec: { ...r.spec, ...patch } }));

  const pick = (id: string | null) => {
    if (!picker) return;
    const { role, tab } = picker;
    setPicker(null);
    if (tab === 'heights') {
      updateSpec(role === 'from' ? { fromHeight: id } : { toHeight: id });
      return;
    }
    if (id === null) return;
    if (role === 'to') {
      updateSpec({ to: id });
      return;
    }
    // A new source system: keep the target if a validated plan still exists, else the region's.
    const sys = coordSystem(id);
    if (!sys) return;
    setReq((r) => {
      const spec: ConvertSpec = { ...r.spec, from: id };
      const probe = makePlan(
        { ...spec, ...(FRAMES[sys.frame].dynamic ? { epoch: spec.epoch ?? 2010 } : {}) },
        { xy: [near.lon, near.lat], h: 0, lon: near.lon, lat: near.lat },
        { stations: r.stations ?? [] },
      );
      if (
        !probe.ok &&
        ['unvalidated-pair', 'outside-region', 'out-of-zone'].includes(probe.refusal.code)
      ) {
        const t = defaultTarget(sys.frame, near.lon, near.lat);
        spec.to = t.to;
        spec.toHeight = spec.fromHeight ? t.toHeight : null;
      }
      const same = sys.kind === (r.spec.from === id ? sys.kind : coordSystem(r.spec.from)?.kind);
      const { approxPosition: _approx, ...rest } = r;
      return {
        ...rest,
        spec,
        ...(same ? {} : { a: '', b: '', c: '' }),
        origin: { kind: 'point', label: 'Typed coordinates' },
      };
    });
  };

  const swap = () => {
    if (ev.status !== 'ok' || !ev.output || req.spec.to === 'same' || !toSys) return;
    const o = ev.output;
    const geo = toSys.kind === 'geographic';
    const a = geo ? (o.xy[1] ?? 0).toFixed(9) : (o.xy[0] ?? 0).toFixed(4);
    const b = geo ? (o.xy[0] ?? 0).toFixed(9) : (o.xy[1] ?? 0).toFixed(4);
    const c = toSys.kind === 'geocentric' ? (o.xy[2] ?? 0).toFixed(4) : undefined;
    const outEpoch = ev.plan?.outEpoch;
    setReq((r) => ({
      ...r,
      spec: {
        from: r.spec.to,
        fromHeight: r.spec.toHeight,
        to: r.spec.from,
        toHeight: r.spec.fromHeight,
        ...(outEpoch !== undefined ? { epoch: outEpoch } : {}),
        ...(r.spec.epoch !== undefined ? { toEpoch: r.spec.epoch } : {}),
      },
      a,
      b,
      ...(c !== undefined ? { c } : {}),
      ...(o.h !== undefined ? { h: o.h.toFixed(4) } : {}),
      ...(outEpoch !== undefined ? { epoch: outEpoch.toFixed(2) } : {}),
      ...(r.epoch !== undefined ? { toEpoch: r.epoch } : {}),
      origin: { kind: 'point', label: 'Swapped result' },
      published: [],
    }));
  };

  const copy = (text: string, key: string, what: string) => {
    void Clipboard.setStringAsync(text);
    setCopied(key);
    showSnack(`Copied ${what}`);
  };
  const copyAll = () => {
    void Clipboard.setStringAsync(ev.copyAll);
    showSnack('Copied the results and their accuracy');
  };
  const share = () => {
    void Share.share({ message: ev.copyAll });
  };
  const showOnMap = () => {
    if (!ev.mapPoint) return;
    aim({ latitude: ev.mapPoint.lat, longitude: ev.mapPoint.lon });
    router.navigate('/');
  };

  const offer: Pack[] = useMemo(() => {
    if (ev.refusal?.code !== 'missing-grid' || !index || !ev.sourcePoint) return [];
    const { packs } = packsForGrids(
      index,
      ev.refusal.grids ?? [],
      ev.sourcePoint.lon,
      ev.sourcePoint.lat,
    );
    return packs;
  }, [ev, index]);

  const chart = !!(
    req.spec.fromHeight?.includes('@') ||
    req.spec.toHeight?.includes('@') ||
    ['cd-no', 'lat-nl'].includes(req.spec.fromHeight ?? '') ||
    ['cd-no', 'lat-nl'].includes(req.spec.toHeight ?? '')
  );
  const ft = coordTitle(req.spec.from);
  const tt =
    req.spec.to === 'same'
      ? { title: 'Same position', subtitle: 'heights only', icon: 'grid' }
      : coordTitle(req.spec.to);
  const epochSub = fromFrame?.dynamic
    ? `coordinate epoch ${req.epoch?.trim() ? req.epoch : '—'}${req.epoch && CSRS_REALISATION[Number(req.epoch)] && from?.frame === 'csrs' ? ` (${CSRS_REALISATION[Number(req.epoch)]})` : ''}`
    : null;
  const toEpochSub = toFrame?.dynamic
    ? `epoch ${ev.plan?.outEpoch !== undefined ? ev.plan.outEpoch.toFixed(2) : req.toEpoch || req.epoch || '—'}${!req.toEpoch ? ' (unchanged)' : ''}`
    : null;
  const fieldLabels =
    from?.kind === 'geographic'
      ? ['Latitude', 'Longitude']
      : from?.kind === 'geocentric'
        ? ['X (m)', 'Y (m)', 'Z (m)']
        : ['Easting (m)', 'Northing (m)'];
  const angleKb = Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default';
  const numKb = Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric';
  const card = { backgroundColor: theme.colors.surface, borderColor: tokens.outlineVariant };

  return (
    <View
      style={[styles.root, { backgroundColor: theme.colors.background, paddingTop: insets.top }]}
      testID="convert-screen"
    >
      <View style={styles.header}>
        <HeaderAction icon="arrow-left" onPress={() => router.back()} accessibilityLabel="Back" />
        <Text
          variant="headlineSmall"
          style={[styles.headerTitle, { color: tokens.ink }]}
          accessibilityRole="header"
        >
          Convert
        </Text>
        <HeaderAction
          icon="map-marker-outline"
          onPress={showOnMap}
          accessibilityLabel="Show on map"
          disabled={!ev.mapPoint}
        />
        <HeaderAction
          icon="history"
          onPress={() => setHistoryOpen(true)}
          accessibilityLabel="History"
        />
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* FROM */}
          <View style={[styles.card, card]} testID="convert-from">
            <View style={styles.cardHead}>
              <Text variant="labelLarge" style={[styles.caps, { color: tokens.inkVariant }]}>
                FROM
              </Text>
              {req.origin && (
                <View style={styles.origin}>
                  <Icon source="crosshairs-gps" size={16} color={tokens.ink} />
                  <Text
                    variant="labelLarge"
                    style={{ color: tokens.ink }}
                    numberOfLines={1}
                    testID="convert-origin"
                  >
                    {req.origin.label}
                  </Text>
                </View>
              )}
            </View>
            <SystemPill
              icon={ft.icon}
              title={ft.title}
              subtitle={[ft.subtitle.replace(/ · coordinate epoch$/, ''), epochSub]
                .filter(Boolean)
                .join(' · ')}
              onPress={() => setPicker({ role: 'from', tab: 'coords' })}
              testID="convert-from-system"
            />
            {req.notice && (
              <Text variant="bodySmall" style={{ color: tokens.status.pausedInk }}>
                {req.notice}
              </Text>
            )}
            <View style={styles.fields}>
              <Field
                label={fieldLabels[0] ?? ''}
                value={req.a}
                onChange={(a) => update({ a })}
                error={ev.inputErrors?.a}
                keyboardType={from?.kind === 'geographic' ? angleKb : numKb}
                testID="convert-a"
              />
              <Field
                label={fieldLabels[1] ?? ''}
                value={req.b}
                onChange={(b) => update({ b })}
                error={ev.inputErrors?.b}
                keyboardType={from?.kind === 'geographic' ? angleKb : numKb}
                testID="convert-b"
              />
            </View>
            {from?.kind === 'geocentric' && (
              <View style={styles.fields}>
                <Field
                  label="Z (m)"
                  value={req.c ?? ''}
                  onChange={(c) => update({ c })}
                  error={ev.inputErrors?.c}
                  keyboardType={numKb}
                  testID="convert-c"
                />
              </View>
            )}
            <View style={styles.fields}>
              {req.spec.fromHeight !== null && (
                <Field
                  label={
                    req.spec.fromHeight.startsWith('cd@') ||
                    req.spec.fromHeight === 'cd-no' ||
                    req.spec.fromHeight === 'lat-nl'
                      ? 'Height above CD (m)'
                      : 'Height (m)'
                  }
                  value={req.h ?? ''}
                  onChange={(h) => update({ h })}
                  error={ev.inputErrors?.h}
                  keyboardType={numKb}
                  testID="convert-h"
                  highlight={req.spec.fromHeight.startsWith('cd@')}
                />
              )}
              {fromFrame?.dynamic && (
                <Field
                  label="Coordinate epoch"
                  value={req.epoch ?? ''}
                  onChange={(epoch) => update({ epoch })}
                  error={ev.inputErrors?.epoch}
                  keyboardType={numKb}
                  testID="convert-epoch"
                />
              )}
            </View>
            <SystemPill
              icon="arrow-expand-vertical"
              muted
              title={heightTitle(req.spec.fromHeight, req).title}
              subtitle={heightTitle(req.spec.fromHeight, req).subtitle}
              onPress={() => setPicker({ role: 'from', tab: 'heights' })}
              testID="convert-from-height"
            />
          </View>

          <View style={styles.swapWrap}>
            <Pressable
              onPress={swap}
              disabled={ev.status !== 'ok' || req.spec.to === 'same'}
              style={[styles.swap, { backgroundColor: tokens.map.chrome }]}
              accessibilityRole="button"
              accessibilityLabel="Swap: convert the result back"
              testID="convert-swap"
            >
              <Icon source="swap-vertical" size={26} color={tokens.map.chromeInk} />
            </Pressable>
          </View>

          {/* TO */}
          <View style={[styles.card, card]} testID="convert-to">
            <View style={styles.cardHead}>
              <Text variant="labelLarge" style={[styles.caps, { color: tokens.inkVariant }]}>
                TO
              </Text>
              {ev.status === 'ok' && (
                <Text variant="labelLarge" style={{ color: tokens.ink }}>
                  {`${ev.rows.length} result${ev.rows.length === 1 ? '' : 's'}`}
                </Text>
              )}
            </View>
            <SystemPill
              icon={tt.icon}
              title={tt.title}
              subtitle={[tt.subtitle.replace(/ · coordinate epoch$/, ''), toEpochSub]
                .filter(Boolean)
                .join(' · ')}
              onPress={() => setPicker({ role: 'to', tab: 'coords' })}
              testID="convert-to-system"
            />
            <SystemPill
              icon="arrow-expand-vertical"
              muted
              title={heightTitle(req.spec.toHeight, req).title}
              subtitle={heightTitle(req.spec.toHeight, req).subtitle}
              onPress={() => setPicker({ role: 'to', tab: 'heights' })}
              testID="convert-to-height"
            />
            {toFrame?.dynamic && (
              <View style={styles.fields}>
                <Field
                  label="Target epoch (blank = same)"
                  value={req.toEpoch ?? ''}
                  onChange={(toEpoch) => update({ toEpoch })}
                  error={ev.inputErrors?.toEpoch}
                  keyboardType={numKb}
                  testID="convert-to-epoch"
                />
              </View>
            )}
            {ev.rows.map((r) => (
              <View key={r.key} style={styles.result} testID={`convert-result-${r.key}`}>
                <Text
                  variant="labelLarge"
                  style={[styles.caps, styles.resultLabel, { color: tokens.inkVariant }]}
                >
                  {r.label.toUpperCase()}
                </Text>
                <View style={styles.flex}>
                  <Text
                    variant="titleLarge"
                    style={[styles.value, { color: tokens.ink }]}
                    selectable
                    accessibilityLabel={`${r.label} ${r.value}`}
                  >
                    {r.value}
                  </Text>
                  {r.note ? (
                    <Text variant="bodySmall" style={{ color: tokens.inkVariant }}>
                      {r.note}
                    </Text>
                  ) : null}
                </View>
                <IconButton
                  icon={copied === r.key ? 'check' : 'content-copy'}
                  size={20}
                  iconColor={copied === r.key ? theme.colors.primary : tokens.ink}
                  onPress={() => copy(r.copy, r.key, r.label.toLowerCase())}
                  accessibilityLabel={`Copy ${r.label}`}
                />
              </View>
            ))}
            {ev.status === 'empty' && (
              <Text variant="bodyMedium" style={{ color: tokens.inkVariant }}>
                Type or paste coordinates above.
              </Text>
            )}
          </View>

          {ev.panel && (
            <AccuracyPanel
              panel={ev.panel}
              offer={offer}
              downloading={downloading}
              downloadError={downloadError}
              onDownload={(p) => void download(p)}
              chart={chart}
              lite={!native}
            />
          )}
        </ScrollView>
        <View style={[styles.actions, { paddingBottom: insets.bottom + space.sm }]}>
          <Button
            mode="contained"
            icon="map-marker-outline"
            onPress={showOnMap}
            disabled={!ev.mapPoint || ev.status !== 'ok'}
            style={styles.grow}
            contentStyle={styles.actionContent}
            buttonColor={tokens.map.chrome}
            textColor={tokens.map.chromeInk}
            testID="convert-show-on-map"
          >
            Show on map
          </Button>
          <Button
            mode="outlined"
            icon="content-copy"
            onPress={copyAll}
            disabled={ev.status !== 'ok'}
            contentStyle={styles.actionContent}
            testID="convert-copy-all"
          >
            Copy all
          </Button>
          <IconButton
            icon="share-variant-outline"
            mode="outlined"
            onPress={share}
            disabled={ev.status !== 'ok'}
            accessibilityLabel="Share"
            style={styles.shareBtn}
          />
        </View>
      </KeyboardAvoidingView>

      {picker && (
        <SystemPicker
          title={`${picker.role === 'from' ? 'Source' : 'Target'} ${picker.tab === 'coords' ? 'coordinate system' : 'height system'}`}
          tab={picker.tab}
          onTab={(tab) => setPicker({ ...picker, tab })}
          allowNone
          selected={
            picker.tab === 'coords'
              ? picker.role === 'from'
                ? req.spec.from
                : req.spec.to
              : picker.role === 'from'
                ? req.spec.fromHeight
                : req.spec.toHeight
          }
          sections={(q) =>
            picker.tab === 'coords'
              ? coordinateSections(
                  picker.role,
                  { ...req.spec, ...(fromFrame?.dynamic ? { epoch: req.spec.epoch ?? 2010 } : {}) },
                  near,
                  q,
                  req.stations ?? [],
                )
              : heightSections(
                  picker.role,
                  {
                    ...req.spec,
                    ...(fromFrame?.dynamic ? { epoch: Number(req.epoch) || 2010 } : {}),
                  },
                  near,
                  {
                    query: q,
                    stations: req.stations ?? [],
                    available: (g) =>
                      env.installed.some((x) => x.name === g) || g === 'us_nga_egm96_15.tif',
                  },
                )
          }
          onPick={pick}
          onClose={() => setPicker(null)}
        />
      )}
      {historyOpen && (
        <View style={StyleSheet.absoluteFill} testID="convert-history">
          <Pressable
            style={[StyleSheet.absoluteFill, styles.scrim]}
            onPress={() => setHistoryOpen(false)}
            accessibilityLabel="Close history"
          />
          <View
            style={[
              styles.historySheet,
              { backgroundColor: theme.colors.surface, paddingBottom: insets.bottom + space.md },
            ]}
          >
            <Text variant="titleLarge" style={[styles.historyTitle, { color: tokens.ink }]}>
              History
            </Text>
            <ScrollView>
              {history.length === 0 && (
                <Text
                  variant="bodyMedium"
                  style={[styles.historyEmpty, { color: tokens.inkVariant }]}
                >
                  Your conversions appear here.
                </Text>
              )}
              {history.map((h) => (
                <Pressable
                  key={`${h.at}-${h.title}`}
                  style={styles.historyRow}
                  onPress={() => {
                    const r = fromParams(h.params);
                    if (r) setReq(r);
                    setHistoryOpen(false);
                  }}
                >
                  <Text variant="titleSmall" style={{ color: tokens.ink }} numberOfLines={2}>
                    {h.title}
                  </Text>
                  <Text variant="bodySmall" style={{ color: tokens.inkVariant }}>
                    {new Date(h.at).toLocaleString()}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      )}
      <Snackbar
        visible={snack !== null}
        onDismiss={dismissSnack}
        duration={Infinity}
        style={{ marginBottom: insets.bottom + 72 }}
      >
        {snack ?? ''}
      </Snackbar>
    </View>
  );
}

function SystemPill({
  icon,
  title,
  subtitle,
  onPress,
  muted,
  testID,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onPress: () => void;
  muted?: boolean;
  testID: string;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const bg = muted ? theme.colors.elevation.level2 : theme.colors.surfaceVariant;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.pill, { backgroundColor: bg }]}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}. Change`}
      testID={testID}
    >
      <Icon source={icon} size={24} color={tokens.ink} />
      <View style={styles.flex}>
        <Text
          variant="titleMedium"
          style={[styles.pillTitle, { color: tokens.ink }]}
          numberOfLines={2}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodySmall" style={{ color: tokens.inkVariant }} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Icon source="chevron-down" size={24} color={tokens.ink} />
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChange,
  error,
  keyboardType,
  testID,
  highlight,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  keyboardType: 'numbers-and-punctuation' | 'default' | 'numeric';
  testID: string;
  highlight?: boolean;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const border = error
    ? theme.colors.error
    : highlight
      ? theme.dark
        ? palette.sage
        : palette.sageDeep
      : tokens.outline;
  return (
    <View style={[styles.field, { borderColor: border, borderWidth: highlight || error ? 2 : 1 }]}>
      <Text variant="bodySmall" style={{ color: error ? theme.colors.error : tokens.inkVariant }}>
        {error ?? label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType}
        autoCorrect={false}
        autoCapitalize="characters"
        // Long values (a DMS coordinate as the agency prints it) step down so they stay readable.
        style={[
          styles.fieldInput,
          value.length > 11 && styles.fieldInputLong,
          { color: tokens.ink },
        ]}
        accessibilityLabel={label}
        testID={testID}
        selectTextOnFocus
        returnKeyType="done"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    paddingLeft: space.xs,
    paddingRight: space.xs,
  },
  headerTitle: { flex: 1, fontWeight: '800', marginLeft: space.xs },
  content: { padding: space.md, paddingBottom: space.xl },
  card: { borderRadius: radius.lg + 4, borderWidth: 1, padding: space.md, gap: space.sm },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  caps: { letterSpacing: 1.2 },
  origin: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
    marginLeft: space.md,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  pillTitle: { fontWeight: '700' },
  fields: { flexDirection: 'row', gap: space.md },
  field: {
    flex: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingTop: space.xs,
    paddingBottom: 2,
  },
  fieldInput: { fontSize: 19, paddingVertical: 2, fontVariant: ['tabular-nums'] },
  fieldInputLong: { fontSize: 15 },
  swapWrap: { alignItems: 'center', marginVertical: -space.md, zIndex: 1 },
  swap: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  result: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  resultLabel: { width: 96, paddingTop: 6 },
  value: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  grow: { flexGrow: 1 },
  actionContent: { height: 52 },
  shareBtn: { margin: 0, width: 64, height: 52, borderRadius: 26 },
  scrim: { backgroundColor: 'rgba(20,24,28,0.45)' },
  historySheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '70%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: space.lg,
  },
  historyTitle: { fontWeight: '700', marginHorizontal: space.lg, marginBottom: space.sm },
  historyEmpty: { margin: space.lg },
  historyRow: { paddingHorizontal: space.lg, paddingVertical: space.md },
});
