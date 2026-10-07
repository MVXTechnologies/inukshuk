/**
 * Shared with the team (#589): the waypoints and trails members shared (drawn
 * on everyone's map), and sharing one of mine from the Library. Waypoints are
 * shared records any member may delete; a trail belongs to whoever shared it
 * (they or an admin can take it back). Photos are not shared in this version.
 */
import { loadTrackGeometry } from '@data/trackGeometry';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Button, IconButton, List, Text } from 'react-native-paper';

import { ChoiceRow, Note, SectionLabel, TeamScreenFrame } from './components';
import { actionMessage } from './messages';
import { shareTrailPhotos } from './shareTrailPhotos';

const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

export function ShareScreen() {
  const t = useSchemeTokens();
  const view = useTeamStore((s) => s.view);
  const shares = useTeamStore((s) => s.shares);
  const teamPhotos = useTeamStore((s) => s.photos);
  const router = useRouter();
  const photoCount = (trackId: string) => teamPhotos.filter((p) => p.trackId === trackId).length;
  const tracks = useLibraryStore((s) => s.tracks);
  const waypoints = useLibraryStore((s) => s.waypoints);
  const [picking, setPicking] = useState<'none' | 'trail' | 'waypoint'>('none');
  const [busy, setBusy] = useState<string | null>(null);
  if (view === null) return <TeamScreenFrame title="Shared">{null}</TeamScreenFrame>;
  const session = teamService()?.active;
  const nameOf = (id: string | null) => view.members.find((m) => m.id === id)?.name ?? 'a teammate';
  const canShare = view.active && !view.readOnly && view.myRole !== 'guest';
  const done = (err: string | null | undefined, what: string) => {
    if (err) Alert.alert('Not shared', actionMessage(err));
    else Alert.alert(`${what} shared with the team`);
    setPicking('none');
    useTeamStore.getState().refresh();
  };

  const shareTrail = async (id: string) => {
    const summary = tracks.find((x) => x.id === id);
    if (!summary || !session) return;
    setBusy(id);
    try {
      const geom = await loadTrackGeometry(summary);
      if (!geom) throw new Error('Could not read the trail');
      const points: { latitude: number; longitude: number }[] = [];
      const segmentStarts: number[] = [];
      for (const part of geom.parts) {
        if (points.length > 0) segmentStarts.push(points.length);
        for (const [lng, lat] of part) points.push({ latitude: lat, longitude: lng });
      }
      const trackErr = session.shareTrack(
        {
          name: summary.name,
          points,
          segmentStarts,
          distanceM: summary.stats.distanceM,
          ascentM: summary.stats.ascentM,
          startedAt: summary.startedAt,
          ...(summary.endedAt !== undefined ? { endedAt: summary.endedAt } : {}),
          ...(summary.category !== undefined ? { category: summary.category } : {}),
        },
        summary.id,
      );
      if (trackErr) {
        done(trackErr, 'Trail');
        return;
      }
      // Its photos go with it (previews; full size stays on this phone).
      const { shared, error } = await shareTrailPhotos(session, summary.id);
      done(error, shared > 0 ? `Trail and ${shared} photos` : 'Trail');
    } catch (e) {
      reportError(e, 'team-share-trail');
      Alert.alert('Not shared', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <TeamScreenFrame title="Shared with the team" testID="team-share-screen">
      {canShare && (
        <ChoiceRow
          options={[
            { id: 'trail', label: 'Share a trail' },
            { id: 'waypoint', label: 'Share a waypoint' },
          ]}
          value={picking}
          onChange={(v) => setPicking(v === picking ? 'none' : v)}
          testIDPrefix="team-share-pick"
        />
      )}
      {picking === 'trail' &&
        (tracks.length === 0 ? (
          <Text style={{ color: t.inkVariant }}>No trails in your Library yet.</Text>
        ) : (
          [...tracks]
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 30)
            .map((tr) => (
              <List.Item
                key={tr.id}
                title={tr.name}
                description={`${new Date(tr.startedAt).toLocaleDateString()} · ${km(tr.stats.distanceM)}`}
                onPress={() => void shareTrail(tr.id)}
                disabled={busy !== null}
                left={(p) => (
                  <List.Icon {...p} icon={busy === tr.id ? 'progress-upload' : 'map-marker-path'} />
                )}
                style={styles.item}
              />
            ))
        ))}
      {picking === 'waypoint' &&
        (waypoints.length === 0 ? (
          <Text style={{ color: t.inkVariant }}>No waypoints in your Library yet.</Text>
        ) : (
          waypoints.slice(0, 50).map((w) => (
            <List.Item
              key={w.id}
              title={w.label}
              description={w.note ?? `${w.latitude.toFixed(5)}, ${w.longitude.toFixed(5)}`}
              descriptionNumberOfLines={1}
              onPress={() =>
                done(
                  session?.shareWaypoint({
                    latitude: w.latitude,
                    longitude: w.longitude,
                    label: w.label,
                    ...(w.note ? { note: w.note } : {}),
                    ...(w.icon ? { icon: w.icon } : {}),
                  }),
                  'Waypoint',
                )
              }
              left={(p) => <List.Icon {...p} icon="map-marker-outline" />}
              style={styles.item}
            />
          ))
        ))}

      <SectionLabel>{`Waypoints · ${shares.waypoints.length}`}</SectionLabel>
      {shares.waypoints.map((w) => (
        <View key={w.id} style={styles.row}>
          <List.Icon icon="map-marker" color={t.ink} />
          <View style={styles.flex}>
            <Text variant="titleSmall" style={{ color: t.ink }}>
              {w.name}
            </Text>
            <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={1}>
              {w.note ? `${w.note} · ` : ''}by {nameOf(w.by)}
            </Text>
          </View>
          {canShare && (
            <IconButton
              icon="delete-outline"
              accessibilityLabel={`Remove ${w.name} from the team`}
              onPress={() => done(session?.deleteWaypoint(w.id), 'Removal')}
            />
          )}
        </View>
      ))}
      <SectionLabel>{`Trails · ${shares.tracks.length}`}</SectionLabel>
      {shares.tracks.map((tr) => (
        <View key={`${tr.owner}:${tr.id}`} style={styles.row}>
          <List.Icon icon="map-marker-path" color={t.ink} />
          <Pressable
            style={styles.flex}
            onPress={() => router.push(`/team/trail/${tr.owner}/${tr.id}`)}
            accessibilityRole="button"
            testID={`team-shared-trail-${tr.name}`}
          >
            <Text variant="titleSmall" style={{ color: t.ink }}>
              {tr.name}
            </Text>
            <Text variant="bodySmall" style={{ color: t.inkVariant }}>
              {km(tr.distanceM)} · {nameOf(tr.owner)}
              {photoCount(tr.id) > 0 ? ` · ${photoCount(tr.id)} photos` : ''}
            </Text>
          </Pressable>
          {(tr.owner === view.me || view.isAdmin) && !view.readOnly && (
            <IconButton
              icon="delete-outline"
              accessibilityLabel={`Remove ${tr.name} from the team`}
              onPress={() => done(session?.deleteTrack(tr.id, tr.owner), 'Removal')}
            />
          )}
        </View>
      ))}
      <Note>
        Shared waypoints and trails show on every member’s map while Team mode is on. A trail’s
        photos go with it as previews; full-size copies stay on your phone.
      </Note>
      {!canShare && view.myRole === 'guest' && (
        <Button disabled mode="text">
          Guests can’t share waypoints or trails
        </Button>
      )}
    </TeamScreenFrame>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  item: { paddingHorizontal: 0 },
});
