import { formatDistance, type Units } from '@core/format';
import { waypointRowDetail, waypointsByDistance } from '@core/library/waypointsByDistance';
import type { LatLng } from '@core/models';
import { useMapStore } from '@state/mapStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useScreenReaderEnabled } from '../../common/useScreenReaderEnabled';
import { useScreenSheet } from '../../common/useScreenSheet';
import { SheetHeader, useSheetWidth } from '../components/mapSheet';

/** What the list needs of a drawn pin (MapScreen's `visiblePins`). */
export interface ListedPin extends LatLng {
  source: 'saved' | 'live';
  id: string;
  label: string;
}

interface Props {
  /** The pins drawn on the map right now. */
  pins: readonly ListedPin[];
  /** Your GPS fix; without one the list measures from the map centre. */
  here: LatLng | null;
  units: Units;
  /** Open that pin's card (Navigate, Edit, Move, Delete), as a tap on it does. */
  onOpen: (pin: ListedPin) => void;
  /** False while another mode owns the map (the button steps aside). */
  available: boolean;
  /** The Map tab is focused: Back closes the list only then. */
  screenFocused: boolean;
  /** Where the button sits (under the compass). */
  top: number;
}

interface Row {
  pin: ListedPin;
  /** "120 m north-east", or null when there was nothing to measure from. */
  detail: string | null;
}

interface Opened {
  rows: Row[];
  /** What the distances are measured from, said under the title. */
  note: string;
}

/** Sort the pins once, from `here`, else the map centre, else not at all. */
function openList(pins: readonly ListedPin[], here: LatLng | null, units: Units): Opened {
  if (pins.length === 0) return { rows: [], note: 'No waypoints on the map.' };
  const origin = here ?? useMapStore.getState().mapCenter;
  if (origin === null) return { rows: pins.map((pin) => ({ pin, detail: null })), note: '' };
  return {
    rows: waypointsByDistance(pins, origin).map((n) => ({
      pin: n.item,
      detail: waypointRowDetail(formatDistance(n.distanceM, units), n),
    })),
    note: here !== null ? 'Nearest first, from you.' : 'Nearest first, from the map centre.',
  };
}

/**
 * The pins, for screen-reader users only (2.5.1 review). Since #675 the pins
 * are GL symbols — one layer, no view per pin — and a symbol has no
 * accessibility node, so TalkBack and VoiceOver could no longer reach them.
 * While a screen reader is on, a button "Waypoints on the map (N)" opens a
 * list of the drawn pins, nearest first from you (or from the map centre
 * before a fix), and a row opens that pin's card exactly as a tap on the pin
 * does — which brings back Navigate, Edit, Move and Delete.
 *
 * Nothing renders for sighted users. The list is sorted once when it opens,
 * not per fix: rows re-sorting under the screen reader's focus would move
 * the one being read. While open it is a sheet (plain themed View, never a
 * Portal) that takes Android Back and hides the tab bar (`useScreenSheet`).
 */
export function WaypointScreenReaderList(props: Props) {
  const screenReader = useScreenReaderEnabled();
  if (!screenReader) return null;
  return <ListControl {...props} />;
}

function ListControl({ pins, here, units, onOpen, available, screenFocused, top }: Props) {
  const tokens = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const width = useSheetWidth();
  const [opened, setOpened] = useState<Opened | null>(null);
  const close = () => setOpened(null);
  useScreenSheet(opened !== null && screenFocused, close);

  const open = () => setOpened(openList(pins, here, units));

  const count = pins.length;
  return (
    <>
      {available && opened === null && (
        <View style={[styles.buttonDock, { top }]} pointerEvents="box-none">
          <Pressable
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel={`Waypoints on the map (${count})`}
            accessibilityHint="Lists the waypoints nearest first; each opens its card"
            testID="waypoint-a11y-list-button"
            style={[styles.button, { backgroundColor: tokens.map.chrome }]}
          >
            <Text style={[styles.buttonText, { color: tokens.map.chromeInk }]}>
              {`Waypoints (${count})`}
            </Text>
          </Pressable>
        </View>
      )}
      {opened !== null && (
        <View style={styles.root} testID="waypoint-a11y-list">
          <Pressable
            style={styles.scrim}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close waypoint list"
          />
          <View
            testID="waypoint-a11y-list-sheet"
            style={[
              styles.sheet,
              {
                top: insets.top + 40,
                width,
                paddingBottom: insets.bottom + 8,
                backgroundColor: tokens.surface,
              },
            ]}
          >
            <SheetHeader
              title="Waypoints on the map"
              closeLabel="Close waypoint list"
              onClose={close}
            />
            {opened.note !== '' && (
              <Text style={[styles.subtitle, { color: tokens.inkVariant }]}>{opened.note}</Text>
            )}
            <FlatList
              data={opened.rows}
              keyExtractor={(r) => `${r.pin.source}-${r.pin.id}`}
              renderItem={({ item: row }) => {
                const label =
                  row.detail === null ? row.pin.label : `${row.pin.label}, ${row.detail}`;
                return (
                  <Pressable
                    onPress={() => {
                      close();
                      onOpen(row.pin);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityHint="Opens its card: Navigate, Edit, Move, Delete"
                    style={({ pressed }) => [
                      styles.row,
                      { borderBottomColor: tokens.outlineVariant },
                      pressed && { backgroundColor: tokens.surfaceVariant },
                    ]}
                  >
                    <Text style={[styles.rowName, { color: tokens.ink }]} numberOfLines={1}>
                      {row.pin.label}
                    </Text>
                    {row.detail !== null && (
                      <Text style={[styles.rowDetail, { color: tokens.inkVariant }]}>
                        {row.detail}
                      </Text>
                    )}
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  buttonDock: { position: 'absolute', left: 16 },
  button: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 14,
    borderRadius: 24,
    justifyContent: 'center',
  },
  buttonText: { fontSize: 14, fontWeight: '700' },
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 30 },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(20,24,28,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    alignSelf: 'center',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
  },
  subtitle: { fontSize: 13, paddingHorizontal: 20, paddingBottom: 8 },
  row: {
    minHeight: 56,
    paddingHorizontal: 20,
    paddingVertical: 10,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowName: { fontSize: 16, fontWeight: '600' },
  rowDetail: { fontSize: 13, marginTop: 2 },
});
