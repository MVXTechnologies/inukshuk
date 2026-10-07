/**
 * A trail a teammate shared (#589): its outline, stats, photos (thumbnails;
 * full size stays on the sharer's phone in v1) and the team's comments on the
 * trail and on each photo, with a box to add one. Opened from Shared, from a
 * comment notification, or with `?photo=` on a given photo.
 */
import { formatDistance } from '@state/formatters';
import { teamService, useTeamStore } from '@state/teamStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { MemberAvatar, Note, SectionLabel, TeamScreenFrame } from './components';
import { actionMessage } from './messages';
import { commentTime, TeamComments } from './TeamComments';

function outline(parts: readonly [number, number][][], w: number, h: number) {
  const all = parts.flat();
  if (all.length === 0) return { lines: [] as string[], project: () => [0, 0] as [number, number] };
  const lats = all.map((p) => p[1]);
  const lngs = all.map((p) => p[0]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const sx = (maxLng - minLng) * k || 1e-6;
  const sy = maxLat - minLat || 1e-6;
  const pad = 14;
  const scale = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy);
  const ox = (w - sx * scale) / 2;
  const oy = (h - sy * scale) / 2;
  const project = (lng: number, lat: number): [number, number] => [
    ox + (lng - minLng) * k * scale,
    oy + (maxLat - lat) * scale,
  ];
  const lines = parts.map((part) =>
    part
      .map(([lng, lat]) =>
        project(lng, lat)
          .map((v) => v.toFixed(1))
          .join(','),
      )
      .join(' '),
  );
  return { lines, project };
}

export function TeamTrailScreen() {
  const t = useSchemeTokens();
  const { width } = useWindowDimensions();
  const { owner, id, photo } = useLocalSearchParams<{
    owner: string;
    id: string;
    photo?: string;
  }>();
  const view = useTeamStore((s) => s.view);
  const shares = useTeamStore((s) => s.shares);
  const allPhotos = useTeamStore((s) => s.photos);
  const dataVersion = useTeamStore((s) => s.dataVersion);
  const [selected, setSelected] = useState<string | null>(photo ?? null);
  const session = teamService()?.active ?? null;
  const trail = shares.tracks.find((tr) => tr.owner === owner && tr.id === id);
  const photos = useMemo(
    () => allPhotos.filter((p) => p.trackId === id && p.owner === owner),
    [allPhotos, id, owner],
  );
  const comments = useMemo(
    () => (session ? session.trailComments(id) : []),
    // dataVersion: re-read when team data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, id, dataVersion],
  );
  if (view === null || session === null)
    return <TeamScreenFrame title="Trail">{null}</TeamScreenFrame>;
  if (!trail) {
    return (
      <TeamScreenFrame title="Shared trail">
        <Note>This trail is no longer shared with the team.</Note>
      </TeamScreenFrame>
    );
  }
  const by = view.members.find((m) => m.id === owner);
  const W = width - 32;
  const H = 190;
  const { lines, project } = outline(trail.parts, W, H);
  const ordinal = new Map(photos.map((p, i) => [p.id, i + 1]));
  const sel = photos.find((p) => p.id === selected) ?? null;
  const shown = sel ? comments.filter((c) => c.photoId === sel.id) : comments;

  return (
    <TeamScreenFrame title={trail.name} testID="team-trail-screen">
      <View style={styles.by}>
        {by && <MemberAvatar initials={by.initials} color={by.color} size={28} />}
        <Text variant="bodyMedium" style={{ color: t.inkVariant }}>
          {by?.isMe ? 'Shared by you' : `Shared by ${by?.name ?? 'a teammate'}`} ·{' '}
          {formatDistance(trail.distanceM)} · {new Date(trail.startedAt).toLocaleDateString()}
        </Text>
      </View>
      <View style={[styles.map, { backgroundColor: t.surfaceVariant, height: H }]}>
        <Svg width={W} height={H}>
          {lines.map((pts, i) => (
            <Polyline
              key={i}
              points={pts}
              fill="none"
              stroke={by?.color ?? t.ink}
              strokeWidth={3}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {photos.map((p) => {
            const [x, y] = project(p.lng, p.lat);
            const on = p.id === selected;
            return (
              <Circle
                key={p.id}
                cx={x}
                cy={y}
                r={on ? 7 : 5}
                fill={on ? t.ink : t.surface}
                stroke={t.ink}
                strokeWidth={2}
              />
            );
          })}
        </Svg>
      </View>

      {photos.length > 0 && (
        <>
          <SectionLabel>{`Photos · ${photos.length}`}</SectionLabel>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}
          >
            {photos.map((p) => {
              const on = p.id === selected;
              const n = comments.filter((c) => c.photoId === p.id).length;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => setSelected(on ? null : p.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Photo ${ordinal.get(p.id)}${n ? `, ${n} comments` : ''}`}
                  testID={`team-trail-photo-${ordinal.get(p.id)}`}
                  style={[styles.thumbWrap, { borderColor: on ? t.ink : 'transparent' }]}
                >
                  {p.thumbUri ? (
                    <Image source={{ uri: p.thumbUri }} style={styles.thumb} />
                  ) : (
                    <View style={[styles.thumb, { backgroundColor: t.surfaceVariant }]} />
                  )}
                  {n > 0 && (
                    <View style={[styles.count, { backgroundColor: t.ink }]}>
                      <Text style={[styles.countText, { color: t.background }]}>{n}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      )}
      {sel && (
        <View style={styles.big}>
          {sel.thumbUri && (
            <Image
              source={{ uri: sel.thumbUri }}
              style={[
                styles.bigImage,
                { aspectRatio: sel.width && sel.height ? sel.width / sel.height : 4 / 3 },
              ]}
              resizeMode="cover"
              testID="team-trail-photo-large"
            />
          )}
          <Text variant="bodySmall" style={{ color: t.inkMuted }}>
            {`Photo ${ordinal.get(sel.id)}${sel.takenAt ? ` · ${commentTime(sel.takenAt)}` : ''}${sel.caption ? ` · ${sel.caption}` : ''} · preview (full size stays on ${by?.isMe ? 'your' : 'the sharer’s'} phone)`}
          </Text>
        </View>
      )}

      <SectionLabel>
        {sel ? `Comments on photo ${ordinal.get(sel.id)}` : `Comments · ${comments.length}`}
      </SectionLabel>
      <TeamComments
        comments={shown}
        members={view.members}
        me={view.me}
        canWrite={view.active && !view.readOnly}
        placeholder={sel ? 'Comment on this photo' : 'Comment on the trail'}
        photoLabel={(pid) => (ordinal.has(pid) ? `photo ${ordinal.get(pid)}` : null)}
        onSend={(text, mentions) => {
          const err = sel
            ? session.commentOnPhoto(sel.id, text, mentions)
            : session.commentOnTrail(id, text, mentions);
          useTeamStore.getState().refresh();
          return err ? actionMessage(err) : null;
        }}
        testID="team-trail-comments"
      />
    </TeamScreenFrame>
  );
}

const styles = StyleSheet.create({
  by: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: -space.sm },
  map: { borderRadius: 14, overflow: 'hidden' },
  strip: { gap: space.sm },
  thumbWrap: { borderWidth: 2, borderRadius: 12, padding: 2 },
  thumb: { width: 84, height: 84, borderRadius: 9 },
  count: {
    position: 'absolute',
    right: 6,
    top: 6,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  countText: { fontSize: 11, fontWeight: '800' },
  big: { gap: space.xs },
  bigImage: { width: '100%', borderRadius: 14 },
});
