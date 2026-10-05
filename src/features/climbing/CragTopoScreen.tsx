import {
  accessView,
  approachLabel,
  routesLabel,
  SAFETY_LINE,
  sectorList,
  styleLine,
  summaryFromDetail,
  topoCredits,
} from '@core/climbing/card';
import { downloadable, STYLE_LABELS } from '@core/climbing/crag';
import { approachText, filterRoutes, type CragRoute, type CragSector } from '@core/climbing/detail';
import { routeGrade, type GradeSystem } from '@core/climbing/grades';
import { cragMapBounds, cragPoints, savedBytes } from '@core/climbing/saved';
import { foldName } from '@core/climbing/search';
import { formatBytes } from '@core/format';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { attachmentUri, loadTopo, type TopoLoad } from '@data/climbing';
import { openExternalLink } from '@lib/openLink';
import { useClimbingStore } from '@state/climbingStore';
import { useMapStore } from '@state/mapStore';
import { palette, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { ActivityIndicator, Icon, Snackbar, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccessPill, BandBar, Pill, useClimbingColors, useGradeSystem } from './ClimbingParts';
import {
  attachTopo,
  CragDownloadError,
  downloadCrag,
  estimateCragMap,
  removeAttachment,
} from './climbingActions';
import { DiagramLegend, GradeChartView, WallDiagram } from './CragDiagram';
import { DownloadCragSheet } from './DownloadCragSheet';

const SOURCE_SHORT: Record<string, string> = { osm: 'OSM', ob: 'OpenBeta', c2c: 'camptocamp' };
const LINK_LABEL: Record<string, string> = {
  fqme: 'FQME sites map: access and the topo for each site',
  c2c: 'camptocamp.org page',
  web: 'The crag’s website',
};
const FOCUS_DELAY_MS = 450;

type Status = 'loading' | 'ready' | 'missing';

function useCragTopo(uid: string) {
  const [state, setState] = useState<{ status: Status; topo: TopoLoad | null }>({
    status: 'loading',
    topo: null,
  });
  const savedVersion = useClimbingStore((s) => s.saved.find((c) => c.uid === uid)?.version);
  useEffect(() => {
    let live = true;
    void loadTopo(uid).then((topo) => {
      if (live) setState({ status: topo ? 'ready' : 'missing', topo });
    });
    return () => {
      live = false;
    };
  }, [uid, savedVersion]);
  return state;
}

function routeMeta(r: CragRoute, sector: CragSector, system: GradeSystem): string {
  const grade = routeGrade(r, system, SOURCE_SHORT[sector.src]);
  return [
    r.styles.map((s) => STYLE_LABELS[s]).join(' / ') || null,
    r.bolts !== undefined ? `${r.bolts} bolts` : null,
    r.pitches !== undefined ? `${r.pitches} pitches` : null,
    r.lengthM !== undefined ? `${r.lengthM} m` : null,
    grade?.note ?? null,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');
}

/**
 * A crag's topo (mockups 03 and 03b): sector chips; the generated wall
 * diagram where OSM gives the route order, else the grade chart (never a
 * guessed wall); the routes in the user's grade system; approach and access;
 * "Attach my topo" (local only); link-outs for photo topos (FQME first, then
 * camptocamp, never Mountain Project); every source's credit and the safety
 * line. Works offline from the saved copy, or from the copy cached when it
 * was last opened online.
 */
export function CragTopoScreen({ uid }: { uid: string }) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const c = useClimbingColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const system = useGradeSystem();
  const snack = useTimedSnackbar(4500);
  const { status, topo } = useCragTopo(uid);
  const detail = topo?.detail ?? null;
  const saved = useClimbingStore((s) => s.saved.find((x) => x.uid === uid));
  const download = useClimbingStore((s) => s.downloads[uid]);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const [sectorIdx, setSectorIdx] = useState(0);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  const sector = detail?.sectors[sectorIdx] ?? detail?.sectors[0];
  const routes = useMemo(
    () => (sector ? filterRoutes(sector.routes, query, foldName) : []),
    [sector, query],
  );
  const summary = useMemo(() => (detail ? summaryFromDetail(detail) : null), [detail]);
  const mapBytes = useMemo(() => (detail ? estimateCragMap(cragPoints(detail)) : 0), [detail]);

  const showOnMap = useCallback(() => {
    if (!detail) return;
    router.navigate('/');
    setTimeout(() => setFocusBounds(cragMapBounds(cragPoints(detail), 150)), FOCUS_DELAY_MS);
  }, [detail, router, setFocusBounds]);

  const startDownload = (withMap: boolean) => {
    if (!detail) return;
    void downloadCrag(uid, { withMap })
      .then(() => {
        setConfirming(false);
        snack.show(`${detail.name} is saved offline. It is on your main map too.`);
      })
      .catch((err: unknown) => {
        setConfirming(false);
        snack.show(
          err instanceof CragDownloadError ? err.message : `Couldn't download ${detail.name}`,
        );
      });
  };

  const attach = async (from: 'photo' | 'file') => {
    try {
      if (!saved) await downloadCrag(uid, { withMap: false });
      await attachTopo(uid, from);
    } catch (err) {
      snack.show(err instanceof CragDownloadError ? err.message : 'Couldn’t attach that file');
    }
  };

  if (status !== 'ready' || detail === null || sector === undefined || summary === null) {
    return (
      <View
        style={[
          styles.fill,
          styles.center,
          { backgroundColor: t.background, paddingTop: insets.top },
        ]}
      >
        {status === 'loading' ? (
          <ActivityIndicator />
        ) : (
          <View style={styles.missing}>
            <Icon source="cloud-off-outline" size={36} color={t.inkMuted} />
            <Text style={[styles.body, { color: t.inkVariant, textAlign: 'center' }]}>
              This topo isn’t on your phone yet. Connect to the internet to open it, then download
              it to keep it offline.
            </Text>
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              style={[styles.secondary, { borderColor: t.outlineVariant }]}
            >
              <Text style={[styles.buttonText, { color: t.ink }]}>Back</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  const access = accessView(detail.access.status, detail, detail.access);
  const approach = approachText(detail.approach, 'en');
  const closed = !downloadable(detail.access.status);
  const credits = topoCredits(
    detail.sources,
    detail.sectors.some((s) => s.ordered),
  );
  const viewingAttachment = saved?.attachments.find((a) => a.id === viewing);

  const header = (
    <View style={styles.headerBlock}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {detail.sectors.map((s, i) => {
          const on = s === sector;
          return (
            <Pressable
              key={`${s.name}-${i}`}
              onPress={() => {
                setSectorIdx(i);
                setQuery('');
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={[
                styles.chip,
                on
                  ? { backgroundColor: t.library.chipOn, borderColor: t.library.chipOn }
                  : { backgroundColor: t.surface, borderColor: t.outlineVariant },
              ]}
            >
              <Text style={[styles.chipText, { color: on ? t.library.chipOnInk : t.ink }]}>
                {`${s.name} · ${s.routes.length}`}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {sector.routes.length > 0 &&
        (sector.ordered ? (
          <WallDiagram title={sector.name} routes={sector.routes} />
        ) : (
          <GradeChartView title={sector.name} routes={sector.routes} system={system} />
        ))}
      {sector.routes.length > 0 && <DiagramLegend system={system} diagram={sector.ordered} />}
      {detail.listed === 0 && (
        <Text style={[styles.body, { color: t.inkVariant }]}>
          {`${detail.routeCount > 0 ? `${routesLabel(detail.routeCount)} here, but their` : 'The'} list isn’t in the open data yet. See the link-outs below, or attach your own topo.`}
        </Text>
      )}
      <View style={styles.listHead}>
        <Text style={[styles.overline, { color: t.inkVariant }]} numberOfLines={1}>
          {sector.name.toUpperCase()}
        </Text>
        <Text style={[styles.overline, { color: t.inkVariant }]}>
          {routesLabel(sector.routes.length).toUpperCase()}
        </Text>
      </View>
      {sector.routes.length > 8 && (
        <View style={[styles.field, { borderColor: t.outlineVariant, backgroundColor: t.surface }]}>
          <Icon source="magnify" size={18} color={t.inkMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Find a route by name or grade"
            placeholderTextColor={t.inkMuted}
            accessibilityLabel="Find a route"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => Keyboard.dismiss()}
            style={[styles.input, { color: t.ink }]}
          />
        </View>
      )}
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      <Section title="Approach & access">
        <AccessPill access={access} />
        {access.url !== null && (
          <LinkRow
            label="Check access before you go"
            onPress={() => void openExternalLink(access.url ?? '')}
          />
        )}
        {approachLabel(detail.approach?.min) !== null && (
          <Text style={[styles.body, { color: t.ink }]}>{approachLabel(detail.approach?.min)}</Text>
        )}
        {approach !== null && (
          <>
            <Text style={[styles.body, { color: t.ink }]}>{approach.text}</Text>
            {detail.approach?.src === 'c2c' && (
              <Text style={[styles.small, { color: t.inkMuted }]}>
                {`camptocamp.org contributors, CC BY-SA 3.0${approach.lang !== 'en' ? ` · in ${approach.lang.toUpperCase()}` : ''}`}
              </Text>
            )}
          </>
        )}
        <Text style={[styles.body, { color: t.inkVariant }]}>
          {[
            styleLine(detail.styles),
            detail.rock ? `Rock: ${detail.rock}` : null,
            detail.aspect ? `Faces ${detail.aspect.replace(/;/g, ', ')}` : null,
            detail.height ? `Up to ${detail.height} m` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Section>

      <Section title="Your topo">
        <Text style={[styles.small, { color: t.inkMuted }]}>
          A photo of your guidebook page or a PDF you own, kept with this crag on this phone only.
          Never uploaded or shared.
        </Text>
        {(saved?.attachments ?? []).map((a) => (
          <View key={a.id} style={styles.attachRow}>
            <Pressable
              style={styles.attachMain}
              accessibilityRole="button"
              onPress={() =>
                a.kind === 'image'
                  ? setViewing(a.id)
                  : void Sharing.shareAsync(attachmentUri(a.path), {
                      mimeType: 'application/pdf',
                      UTI: 'com.adobe.pdf',
                    }).catch(() => undefined)
              }
            >
              <Icon
                source={a.kind === 'pdf' ? 'file-pdf-box' : 'image-outline'}
                size={22}
                color={c.crag}
              />
              <Text numberOfLines={1} style={[styles.body, styles.flex, { color: t.ink }]}>
                {a.name}
              </Text>
              <Text style={[styles.small, { color: t.inkMuted }]}>{formatBytes(a.bytes)}</Text>
            </Pressable>
            <Pressable
              onPress={() => removeAttachment(uid, a.id)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${a.name}`}
              hitSlop={8}
            >
              <Icon source="close" size={18} color={t.inkMuted} />
            </Pressable>
          </View>
        ))}
        <View style={styles.row}>
          <Pressable
            onPress={() => void attach('photo')}
            accessibilityRole="button"
            style={[styles.secondary, { borderColor: t.outlineVariant }]}
            testID="crag-attach-photo"
          >
            <Icon source="image-plus" size={18} color={t.ink} />
            <Text style={[styles.buttonText, { color: t.ink }]}>Attach a photo</Text>
          </Pressable>
          <Pressable
            onPress={() => void attach('file')}
            accessibilityRole="button"
            style={[styles.secondary, { borderColor: t.outlineVariant }]}
          >
            <Icon source="file-plus-outline" size={18} color={t.ink} />
            <Text style={[styles.buttonText, { color: t.ink }]}>Attach a file</Text>
          </Pressable>
        </View>
      </Section>

      {detail.links.length > 0 && (
        <Section title="Photo topos for this crag">
          {detail.links.map((l) => (
            <LinkRow
              key={l.url}
              label={LINK_LABEL[l.src] ?? l.url}
              onPress={() => void openExternalLink(l.url)}
            />
          ))}
          <Text style={[styles.small, { color: t.inkMuted }]}>Opens in your browser.</Text>
        </Section>
      )}

      <View style={[styles.safety, { backgroundColor: t.connect.notice }]}>
        <Icon source="alert-outline" size={18} color={t.connect.noticeInk} />
        <Text style={[styles.small, styles.flex, { color: t.connect.noticeInk }]}>
          {SAFETY_LINE}
        </Text>
      </View>
      {credits.map((line) => (
        <Text key={line} style={[styles.small, { color: t.inkMuted }]}>
          {line}
        </Text>
      ))}
      {saved !== undefined && (
        <Text style={[styles.small, { color: t.inkMuted }]}>
          {`Saved on this phone · ${formatBytes(savedBytes(saved))}`}
        </Text>
      )}
    </View>
  );

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.icon}
        >
          <Icon source="arrow-left" size={24} color={t.ink} />
        </Pressable>
        <View style={styles.flex}>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: t.ink }]}
            accessibilityRole="header"
          >
            {detail.name}
          </Text>
          <Text numberOfLines={1} style={[styles.subtitle, { color: t.inkVariant }]}>
            {[detail.region ?? detail.admin1, detail.country].filter(Boolean).join(', ') ||
              sectorList(detail.sectors.map((s) => s.name))}
          </Text>
        </View>
        {saved !== undefined ? (
          <View accessibilityLabel="Saved offline" style={styles.icon}>
            <Icon source="check-circle" size={26} color={t.library.onMapInk} />
          </View>
        ) : (
          !closed && (
            <Pressable
              onPress={() => setConfirming(true)}
              accessibilityRole="button"
              accessibilityLabel="Download for offline"
              style={styles.icon}
              testID="crag-topo-download"
            >
              <Icon source="download" size={26} color={t.ink} />
            </Pressable>
          )
        )}
        <Pressable
          onPress={showOnMap}
          accessibilityRole="button"
          accessibilityLabel="Show on map"
          style={styles.icon}
        >
          <Icon source="map-marker-outline" size={26} color={t.ink} />
        </Pressable>
      </View>
      <View style={styles.summary}>
        <BandBar bands={detail.bands} system={system} legend={false} height={6} />
        {topo?.from === 'cache' && saved === undefined && (
          <Pill label="Last copy you opened · not saved offline" icon="history" />
        )}
      </View>
      <FlatList
        data={routes}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        renderItem={({ item, index }) => {
          const grade = routeGrade(item, system, SOURCE_SHORT[sector.src]);
          const band = grade?.band ?? null;
          const ink = band === null ? c.none : c.bands[band];
          const n =
            sector.ordered && query === ''
              ? index + 1
              : sector.ordered
                ? sector.routes.indexOf(item) + 1
                : null;
          return (
            <View style={[styles.route, { borderBottomColor: t.divider }]}>
              {n !== null ? (
                <View style={[styles.num, { backgroundColor: ink }]}>
                  <Text style={[styles.numText, { color: c.bandInk }]}>{n}</Text>
                </View>
              ) : (
                <View style={[styles.dot, { backgroundColor: ink }]} />
              )}
              <View style={styles.flex}>
                <Text numberOfLines={2} style={[styles.routeName, { color: t.ink }]}>
                  {item.name}
                </Text>
                {routeMeta(item, sector, system) !== '' && (
                  <Text numberOfLines={2} style={[styles.small, { color: t.inkVariant }]}>
                    {routeMeta(item, sector, system)}
                  </Text>
                )}
                {item.desc !== undefined && (
                  <Text numberOfLines={3} style={[styles.small, { color: t.inkMuted }]}>
                    {item.desc}
                  </Text>
                )}
              </View>
              {grade !== null && (
                <View
                  style={[
                    styles.grade,
                    { borderColor: ink, backgroundColor: theme.dark ? 'transparent' : `${ink}1F` },
                  ]}
                >
                  <Text style={[styles.gradeText, { color: theme.dark ? ink : t.ink }]}>
                    {grade.text}
                  </Text>
                </View>
              )}
            </View>
          );
        }}
        ListEmptyComponent={
          query !== '' ? (
            <Text style={[styles.body, { color: t.inkMuted }]}>No route matches.</Text>
          ) : null
        }
      />
      {(confirming || download) && (
        <View
          style={[
            styles.sheet,
            { backgroundColor: t.surface, paddingBottom: insets.bottom + space.md },
          ]}
        >
          <DownloadCragSheet
            crag={summary}
            mapBytes={mapBytes}
            onConfirm={startDownload}
            onCancel={() => setConfirming(false)}
          />
        </View>
      )}
      {viewingAttachment !== undefined && (
        <Pressable
          style={[styles.viewer, { backgroundColor: palette.black }]}
          onPress={() => setViewing(null)}
          accessibilityRole="button"
          accessibilityLabel="Close the photo"
        >
          <Image
            source={{ uri: attachmentUri(viewingAttachment.path) }}
            style={styles.fill}
            resizeMode="contain"
          />
        </Pressable>
      )}
      <Snackbar
        visible={snack.message !== null}
        onDismiss={snack.dismiss}
        duration={Number.POSITIVE_INFINITY}
      >
        {snack.message}
      </Snackbar>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useSchemeTokens();
  return (
    <View style={styles.section}>
      <Text style={[styles.overline, { color: t.inkVariant }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useSchemeTokens();
  return (
    <Pressable onPress={onPress} accessibilityRole="link" style={styles.linkRow}>
      <Text style={[styles.body, styles.flex, { color: t.explore.accent, fontWeight: '700' }]}>
        {label}
      </Text>
      <Icon source="open-in-new" size={18} color={t.explore.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
  missing: { alignItems: 'center', gap: space.md, padding: space.xl },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md },
  icon: { width: target.min, height: target.min, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '800' },
  subtitle: { fontSize: 15, lineHeight: 20 },
  summary: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  list: { paddingHorizontal: space.lg },
  headerBlock: { gap: space.md, paddingBottom: space.sm },
  chips: { gap: space.sm },
  chip: {
    minHeight: 40,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  chipText: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  listHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
    marginTop: space.sm,
  },
  overline: { fontSize: 13, lineHeight: 18, fontWeight: '800', letterSpacing: 1 },
  field: {
    minHeight: 44,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  input: { flex: 1, minWidth: 0, fontSize: 15, padding: 0 },
  route: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  num: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 13, fontWeight: '800' },
  dot: { width: 12, height: 12, borderRadius: 6, marginHorizontal: 8 },
  routeName: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  grade: { borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 3 },
  gradeText: { fontSize: 15, fontWeight: '800' },
  footer: { gap: space.lg, paddingTop: space.lg },
  section: { gap: space.sm },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  secondary: {
    minHeight: target.min,
    paddingHorizontal: space.lg,
    borderRadius: target.min / 2,
    borderWidth: 1,
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  attachMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44 },
  safety: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderRadius: 12,
    alignItems: 'flex-start',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: space.lg,
  },
  viewer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
});
