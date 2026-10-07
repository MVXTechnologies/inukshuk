/**
 * Team mode on the live map (#589, mockup `team-map`): teammates' last shared
 * positions, the team's shared waypoints and trails — native MapLibre layers
 * (GeoJSON sources), mounted as MapView children like the other runtime
 * overlays, in the markers slot (`@core/map/layerSlots`).
 *
 * - A teammate is a dot in their colour with a ring for their role (gold for
 *   admins and the organizer), faded by age band, labelled "Name · 4 min".
 * - No `symbol-sort-key` anywhere: draw order is the source order, and the age
 *   is three bands, never a continuous value (maplibre-symbol-sort-key-cost).
 * - Labels only when the style has a glyph host (`glyphs`); the font stack
 *   follows it like the extensions' labels do (`mapStyle.ts`).
 * - Teammates and shared waypoints draw on top of the whole map (above the
 *   base labels and patterns: they are what a team map is for); shared
 *   trails sit with the trail lines.
 * - Children are arrays, never Fragments (see `mapLayers.tsx`).
 */
import { overlayAnchor } from '@core/map/layerSlots';
import { STONE_FONTS_ATKINSON, STONE_FONTS_NOTO } from '@core/map/stoneStyle';
import { MEMBER_COLORS, memberColor } from '@core/teamui/colors';
import { teammatesGeoJson } from '@core/teamui/positions';
import { STATUS_LABEL } from '@core/teamui/system';
import type { TeamShares } from '@core/teamui/shares';
import type { MemberRow } from '@core/teamui/view';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { FeatureCollection } from 'geojson';
import { useMemo } from 'react';

import { TEAM_MEMBER_LAYER, TEAM_WAYPOINT_LAYER } from './layerIds';

const LINES_ANCHOR = overlayAnchor('trailLines');
const OFM = 'openfreemap';

/** The font stack of the style's glyph host, or null when it has none (no labels then). */
export function teamLabelFont(glyphs: string | undefined): string[] | null {
  if (!glyphs) return null;
  return glyphs.includes(OFM) ? STONE_FONTS_NOTO.bold : STONE_FONTS_ATKINSON.bold;
}

function tracksGeoJson(shares: TeamShares, members: readonly MemberRow[]): FeatureCollection {
  const colour = new Map(members.map((m) => [m.id, m.color]));
  return {
    type: 'FeatureCollection',
    features: shares.tracks.map((t) => ({
      type: 'Feature',
      id: `${t.owner}:${t.id}`,
      geometry: { type: 'MultiLineString', coordinates: t.parts },
      properties: { color: colour.get(t.owner) ?? memberColor(MEMBER_COLORS.length - 1) },
    })),
  };
}

function waypointsGeoJson(shares: TeamShares): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: shares.waypoints.map((w) => ({
      type: 'Feature',
      id: w.id,
      geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
      properties: { waypoint: w.id, label: w.name },
    })),
  };
}

/** Chained `afterId`s keep the team's layers in order, all above the style. */
const afterOf = (id: string | undefined): { afterId?: string } =>
  id === undefined ? {} : { afterId: id };

export function TeamMapLayers({
  glyphs,
  topLayerId,
}: {
  glyphs: string | undefined;
  /** The style's top-most layer: the team draws above it (base labels included). */
  topLayerId: string | undefined;
}) {
  const top = topLayerId;
  const { installedAt, show } = useExtensionPrefs('team');
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const statuses = useTeamStore((s) => s.statuses);
  const shares = useTeamStore((s) => s.shares);
  const members = view?.members;
  // Keep the same object while nothing drawn changed: every new `data` makes
  // MapLibre re-place the symbols, and labels fading in again on each store
  // refresh never reach full opacity. Ages only show to the minute.
  const peopleJson = JSON.stringify(
    teammatesGeoJson(positions, (id) => {
      const st = statuses.get(id);
      return st ? STATUS_LABEL[st.id] : null;
    }),
  );
  const people = useMemo(() => JSON.parse(peopleJson) as FeatureCollection, [peopleJson]);
  const tracks = useMemo(() => tracksGeoJson(shares, members ?? []), [shares, members]);
  const points = useMemo(() => waypointsGeoJson(shares), [shares]);
  const font = teamLabelFont(glyphs);
  const tokens = useSchemeTokens();
  const { mapInk: ink, mapHalo: halo, mapPaper: paper, leadRing, onAvatar } = tokens.team;

  // Children are memoised: <GeoJSONSource> is React.memo'd and re-serialises
  // its data whenever a prop (children included) changes identity.
  const memberLayers = useMemo(
    () => [
      <Layer
        key="halo"
        id="team-member-halo"
        {...afterOf(top)}
        type="circle"
        filter={['==', ['get', 'band'], 'fresh']}
        paint={{
          'circle-radius': 15,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.22,
          'circle-pitch-alignment': 'map',
        }}
      />,
      <Layer
        key="dot"
        id={TEAM_MEMBER_LAYER}
        {...afterOf('team-member-halo')}
        type="circle"
        paint={{
          'circle-radius': 9,
          // Lost (> 15 min): hollow, the member's colour as the ring.
          'circle-color': ['match', ['get', 'band'], 'lost', paper, ['get', 'color']],
          'circle-opacity': ['match', ['get', 'band'], 'fresh', 1, 'stale', 0.55, 0.85],
          'circle-stroke-width': [
            'match',
            ['get', 'band'],
            'lost',
            3,
            ['match', ['get', 'ring'], 'lead', 3, 2],
          ],
          'circle-stroke-color': [
            'match',
            ['get', 'band'],
            'lost',
            ['get', 'color'],
            ['match', ['get', 'ring'], 'lead', leadRing, paper],
          ],
          'circle-stroke-opacity': ['match', ['get', 'band'], 'stale', 0.6, 1],
          'circle-pitch-alignment': 'map',
        }}
      />,
      ...(font
        ? [
            <Layer
              key="initials"
              id="team-member-initials"
              {...afterOf(TEAM_MEMBER_LAYER)}
              type="symbol"
              layout={{
                'text-field': ['get', 'initials'],
                'text-font': font,
                'text-size': 9,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{ 'text-color': onAvatar }}
            />,
            <Layer
              key="label"
              id="team-member-label"
              {...afterOf('team-member-initials')}
              type="symbol"
              layout={{
                'text-field': ['get', 'label'],
                'text-font': font,
                'text-size': 12,
                'text-offset': [0, 1.5],
                'text-anchor': 'top',
                // A handful of teammates: always labelled, never culled by the base map's labels.
                'text-allow-overlap': true,
                'text-ignore-placement': true,
              }}
              paint={{
                'text-color': ink,
                'text-halo-color': halo,
                'text-halo-width': 2,
                'text-opacity': ['match', ['get', 'band'], 'fresh', 1, 0.75],
              }}
            />,
          ]
        : []),
    ],
    [font, ink, halo, paper, leadRing, onAvatar, top],
  );

  const waypointLayers = useMemo(
    () => [
      <Layer
        key="wpt"
        id={TEAM_WAYPOINT_LAYER}
        {...afterOf(top)}
        type="circle"
        paint={{
          'circle-radius': 6,
          'circle-color': paper,
          'circle-stroke-width': 3,
          'circle-stroke-color': ink,
          'circle-pitch-alignment': 'map',
        }}
      />,
      ...(font
        ? [
            <Layer
              key="wpt-label"
              id="team-waypoint-label"
              {...afterOf(TEAM_WAYPOINT_LAYER)}
              type="symbol"
              minzoom={12}
              layout={{
                'text-field': ['get', 'label'],
                'text-font': font,
                'text-size': 11,
                'text-offset': [0.9, 0],
                'text-anchor': 'left',
                'text-optional': true,
              }}
              paint={{ 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.5 }}
            />,
          ]
        : []),
    ],
    [font, ink, halo, paper, top],
  );

  const trackLayers = useMemo(
    () => [
      <Layer
        key="casing"
        id="team-track-casing"
        type="line"
        beforeId={LINES_ANCHOR}
        layout={{ 'line-join': 'round', 'line-cap': 'round' }}
        paint={{ 'line-color': paper, 'line-width': 5, 'line-opacity': 0.8 }}
      />,
      <Layer
        key="line"
        id="team-track-line"
        type="line"
        beforeId={LINES_ANCHOR}
        layout={{ 'line-join': 'round', 'line-cap': 'round' }}
        paint={{ 'line-color': ['get', 'color'], 'line-width': 3 }}
      />,
    ],
    [paper],
  );

  if (installedAt === 0 || !show || view === null) return null;

  return (
    <>
      {shares.tracks.length > 0 && (
        <GeoJSONSource id="team-tracks" data={tracks}>
          {trackLayers}
        </GeoJSONSource>
      )}
      {/* Members mount first: each group chains up from the style's top layer, so
        the later group lands under it (teammates over shared waypoints). */}
      {positions.length > 0 && (
        <GeoJSONSource id="team-members" data={people}>
          {memberLayers}
        </GeoJSONSource>
      )}
      {shares.waypoints.length > 0 && (
        <GeoJSONSource id="team-waypoints" data={points}>
          {waypointLayers}
        </GeoJSONSource>
      )}
    </>
  );
}
