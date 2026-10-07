import type { Units } from '@core/format';
import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';
import { placeDistance, placeKindLine } from '@core/search/format';
import type { Place } from '@core/search/place';
import { PLACE_TYPES } from '@core/search/placeTypes';
import type { RankedPlace } from '@core/search/rank';
import { usePlaceRecentsStore } from '@state/placeRecentsStore';
import { useSettingsStore } from '@state/settingsStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Icon, IconButton, Text, TouchableRipple } from 'react-native-paper';
import { SectionTitle } from '../components/mapSheet';
import { deviceSearchLanguage } from './deviceLanguage';
import { usePlaceSearch, type OnlineStatus } from './usePlaceSearch';

/**
 * "Search places" (#496): the sheet the map's search pill opens. Type a town,
 * a peak, a lake, a campground — or paste a coordinate — and pick a result to
 * fly there. Empty, it lists recent picks.
 *
 * A plain themed View in the rail sheets' visual language (`mapSheet.tsx`),
 * never a Portal/Dialog (the invisible-overlay soft-lock) nor a Paper Surface
 * (the iOS flex collapse). Mounted only while open, so each opening starts
 * with an empty box and the keyboard up.
 */
export function PlaceSearchSheet({
  origin,
  bias,
  onSelect,
  onClose,
}: {
  /** The user's position (distances, proximity), null without a fix. */
  origin: LatLng | null;
  /** Fallback bias for the index without a fix: the map centre. */
  bias: LatLng | null;
  onSelect: (place: Place) => void;
  onClose: () => void;
}) {
  const tokens = useSchemeTokens();
  const { height } = useWindowDimensions();
  const units = useSettingsStore((s) => s.units);
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const recents = usePlaceRecentsStore((s) => s.recents);
  const hydrateRecents = usePlaceRecentsStore((s) => s.hydrate);
  const clearRecents = usePlaceRecentsStore((s) => s.clear);
  const lang = useMemo(() => deviceSearchLanguage(), []);
  const [query, setQuery] = useState('');
  const search = usePlaceSearch({ query, origin, bias, lang, offlineOnly });

  useEffect(() => {
    void hydrateRecents();
  }, [hydrateRecents]);

  // Android back closes the sheet rather than leaving the map.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const pick = (place: Place) => {
    Keyboard.dismiss();
    onSelect(place);
  };

  const recentRows = useMemo<RankedPlace[]>(
    () => recents.map((place) => ({ place, score: 1, distanceM: distanceOrNull(origin, place) })),
    [recents, origin],
  );

  const showLocalSection = search.local.length > 0;
  const cragHits = search.local.filter((r) => r.place.source === 'crag');
  const localHits = search.local.filter((r) => r.place.source !== 'crag');
  const localOnly =
    search.status === 'offline' || search.status === 'local-only' || search.status === 'failed';

  return (
    <View
      style={[
        styles.sheet,
        {
          backgroundColor: tokens.surface,
          borderColor: tokens.outlineVariant,
          maxHeight: Math.max(240, height * 0.62),
        },
      ]}
      accessibilityLabel="Place search"
    >
      <View style={styles.inputRow}>
        <Icon source="magnify" size={22} color={tokens.inkVariant} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCorrect={false}
          autoCapitalize="words"
          returnKeyType="search"
          placeholder="Town, peak, lake, campground…"
          placeholderTextColor={tokens.inkMuted}
          accessibilityLabel="Search places"
          style={[styles.input, { color: tokens.ink }]}
          onSubmitEditing={() => {
            const first = search.coordinate ?? search.online[0] ?? search.local[0];
            if (first !== undefined) pick(first.place);
          }}
        />
        {search.status === 'loading' && (
          <ActivityIndicator size="small" color={tokens.inkMuted} accessibilityLabel="Searching" />
        )}
        {query !== '' && (
          <IconButton
            icon="close-circle"
            size={20}
            iconColor={tokens.inkMuted}
            onPress={() => setQuery('')}
            accessibilityLabel="Clear search"
            style={styles.iconButton}
          />
        )}
        <IconButton
          icon="close"
          size={22}
          iconColor={tokens.inkVariant}
          onPress={onClose}
          accessibilityLabel="Close search"
          style={styles.iconButton}
        />
      </View>
      <View style={[styles.divider, { backgroundColor: tokens.outlineVariant }]} />

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
        {search.empty &&
          (recentRows.length > 0 ? (
            <>
              <View style={styles.sectionRow}>
                <SectionTitle>Recent</SectionTitle>
                <TouchableRipple
                  onPress={clearRecents}
                  accessibilityRole="button"
                  accessibilityLabel="Clear recent searches"
                  style={styles.clearRecents}
                  borderless
                >
                  <Text style={[styles.clearRecentsText, { color: tokens.inkMuted }]}>Clear</Text>
                </TouchableRipple>
              </View>
              {recentRows.map((r) => (
                <ResultRow
                  key={r.place.id}
                  ranked={r}
                  units={units}
                  onPress={pick}
                  icon={r.place.source === 'index' ? 'history' : undefined}
                />
              ))}
            </>
          ) : (
            <Note icon="magnify">
              Find towns, villages, peaks, lakes, campgrounds and parks by name, or paste
              coordinates.
            </Note>
          ))}

        {search.tooShort && <Note icon="keyboard-outline">Keep typing…</Note>}

        {search.coordinate !== null && (
          <ResultRow ranked={search.coordinate} units={units} onPress={pick} />
        )}

        <StatusNote
          status={search.status}
          query={query.trim()}
          nothing={
            search.coordinate === null && search.online.length === 0 && search.local.length === 0
          }
          hasLocal={showLocalSection}
        />

        {/* Climbing crags lead (DESIGN §6.6): a climber typing "Weir" means the crag. */}
        {cragHits.length > 0 && (
          <>
            <SectionTitle>Climbing crags</SectionTitle>
            {cragHits.map((r) => (
              <ResultRow key={r.place.id} ranked={r} units={units} onPress={pick} />
            ))}
          </>
        )}

        {!localOnly &&
          search.online.map((r) => (
            <ResultRow key={r.place.id} ranked={r} units={units} onPress={pick} />
          ))}

        {localHits.length > 0 && (
          <>
            <SectionTitle>On this device</SectionTitle>
            {localHits.map((r) => (
              <ResultRow key={r.place.id} ranked={r} units={units} onPress={pick} />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function distanceOrNull(origin: LatLng | null, place: Place): number | null {
  return origin === null ? null : haversineMeters(origin, place);
}

/** One line of guidance or state, with an icon, in the list. */
function Note({ icon, children, busy }: { icon: string; children: ReactNode; busy?: boolean }) {
  const tokens = useSchemeTokens();
  return (
    <View style={styles.note} accessibilityLiveRegion="polite">
      {busy === true ? (
        <ActivityIndicator size="small" color={tokens.inkMuted} />
      ) : (
        <Icon source={icon} size={20} color={tokens.inkMuted} />
      )}
      <Text style={[styles.noteText, { color: tokens.inkVariant }]}>{children}</Text>
    </View>
  );
}

function StatusNote({
  status,
  query,
  nothing,
  hasLocal,
}: {
  status: OnlineStatus;
  query: string;
  nothing: boolean;
  hasLocal: boolean;
}) {
  const onDevice = hasLocal ? 'Showing matches on this device.' : 'Nothing on this device matches.';
  switch (status) {
    case 'offline':
      return <Note icon="cloud-off-outline">{`Search needs a connection. ${onDevice}`}</Note>;
    case 'local-only':
      return (
        <Note icon="cloud-off-outline">
          {`“Locally downloaded only” is on, so places aren’t searched online. ${onDevice}`}
        </Note>
      );
    case 'busy':
      return <Note icon="timer-sand">Search is busy — try again in a minute.</Note>;
    case 'failed':
      return (
        <Note icon="alert-circle-outline">{`Search is unavailable right now. ${onDevice}`}</Note>
      );
    case 'loading':
      return nothing ? (
        <Note icon="magnify" busy>
          Searching…
        </Note>
      ) : null;
    case 'ready':
      return nothing ? (
        <Note icon="map-search-outline">{`No places found for “${query}”.`}</Note>
      ) : null;
    default:
      return null;
  }
}

function ResultRow({
  ranked,
  units,
  onPress,
  icon,
}: {
  ranked: RankedPlace;
  units: Units;
  onPress: (place: Place) => void;
  /** Overrides the type icon (recents show a clock). */
  icon?: string;
}) {
  const tokens = useSchemeTokens();
  const { place, distanceM } = ranked;
  const kind = placeKindLine(place, units);
  const second = place.context === undefined ? kind : `${kind} · ${place.context}`;
  const distance = placeDistance(distanceM, units);
  return (
    <TouchableRipple
      onPress={() => onPress(place)}
      accessibilityRole="button"
      accessibilityLabel={[place.name, kind, place.context, distance].filter(Boolean).join(', ')}
      style={styles.rowTouch}
      borderless
    >
      <View style={styles.row}>
        <View style={[styles.badge, { backgroundColor: tokens.surfaceVariant }]}>
          <Icon source={icon ?? PLACE_TYPES[place.type].icon} size={20} color={tokens.inkVariant} />
        </View>
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={[styles.name, { color: tokens.ink }]}>
            {place.name}
            {place.altName !== undefined && (
              <Text style={[styles.altName, { color: tokens.inkMuted }]}>
                {`  ${place.altName}`}
              </Text>
            )}
          </Text>
          <Text numberOfLines={1} style={[styles.second, { color: tokens.inkMuted }]}>
            {second}
          </Text>
        </View>
        {distance !== null && (
          <Text style={[styles.distance, { color: tokens.inkMuted }]}>{distance}</Text>
        )}
      </View>
    </TouchableRipple>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: palette.shadow,
    shadowOpacity: 0.28,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
    overflow: 'hidden',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 4,
    minHeight: 52,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 10 },
  iconButton: { margin: 0 },
  divider: { height: StyleSheet.hairlineWidth },
  list: { paddingBottom: 8 },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  clearRecents: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, marginTop: 6 },
  clearRecentsText: { fontSize: 13, fontWeight: '600' },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  noteText: { flex: 1, fontSize: 14, lineHeight: 19 },
  rowTouch: { borderRadius: 12, marginHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  badge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1 },
  name: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  altName: { fontSize: 13, fontWeight: '400' },
  second: { fontSize: 12.5, lineHeight: 16 },
  distance: { fontSize: 13, fontVariant: ['tabular-nums'] },
});
