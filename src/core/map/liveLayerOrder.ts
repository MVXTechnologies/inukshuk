/**
 * THE draw order of the map's own live layers — everything the main map
 * mounts above the style as MapView children: the followed trail, the
 * location puck, the heading cone, the pointing line, the team, trail
 * photos, the waypoint pins. Bottom → top, in ONE list (2.5.1 final QA).
 *
 * ## Why one anchor per layer
 *
 * MapLibre RN re-inserts every child layer when the style reloads (a theme
 * switch, a base-map change), in an order of its own (a hash map), and a
 * layer with no `beforeId` lands on top of everything. Layers placed
 * "after the style's top layer" or "before the puck's ring" therefore came
 * back in whatever order they were re-inserted: after a theme switch the
 * followed trail drew ON TOP of the location dot until you re-followed.
 *
 * So the style itself carries one invisible marker layer per live layer, in
 * this order, at the very top of the stack (`buildOsmStyle`, the `live`
 * slot of `@core/map/layerSlots`); each live layer is inserted just below
 * its own marker (`beforeId={liveLayerAnchor(id)}`). Its height then comes
 * from the style, which is the same after every reload, never from mount or
 * re-insert order — and a marker is always there, so nothing ever waits for
 * a layer that is not mounted (no pins, no team) or falls to the top.
 *
 * ## The order (bottom → top), and why
 *
 * 1. The followed trail and the dashed way back to it: under everything
 *    that marks a point.
 * 2. The puck's accuracy halo and weak-signal ring: soft areas, under any
 *    pin inside them.
 * 3. The heading cone, then the pointing line: directions from you, under
 *    the pins they point across.
 * 4. The team: the rally area and shared trails (lines and areas first),
 *    the rally flag, shared waypoints, the chat/task marks, then teammates
 *    over them.
 * 5. Move mode's dashed line and old spot, under the pins.
 * 6. Trail photos (#587: thumbnails, stacks and their counts, the selected
 *    photo on its ring), then the waypoint pins, their photo badges and their
 *    names: above every line and area, so a pin is never hidden by them, and
 *    a pin over a photo (a pin also wins the tap there).
 * 7. A teammate's SOS: over every pin and photo, under only…
 * 8. The puck's ring and dot, on top of everything: where YOU are must never
 *    be covered (2.5.1 QA: standing on a photo spot, its circle hid the dot).
 *
 * Trail photos are drawn by several instances at once (each trail on the
 * main map, the live recording, team trails), each with its own layer ids
 * (`<instance>-photos-img`, …). They share one anchor per KIND of photo
 * layer: instances stack among themselves in any order, all of them under
 * the pins and the puck.
 *
 * Layers that are NOT here sit below the whole live stack on purpose, each
 * at its slot's anchor (`@core/map/layerSlots` `overlayAnchor`): library and
 * team track lines, the heatmap, a long trail, drawn routes and areas, PDF
 * maps, drapes. Every layer the main map mounts names one or the other;
 * none mounts without a `beforeId`.
 *
 * PURE: no React Native / Expo imports.
 */

export const LIVE_LAYER_ORDER = [
  // 1. Following a trail (#678).
  'followed-trail-casing',
  'followed-trail-line',
  'follow-guide-line',
  // 2. The puck's soft areas.
  'inukshuk-puck-halo',
  'inukshuk-puck-uncertainty',
  // 3. Directions from you.
  'heading-cone-fill',
  'pointing-line-casing',
  'pointing-line',
  'pointing-line-end',
  'pointing-line-labels',
  // 4. Team mode (#589): rally area and shared trails, the rally flag,
  // shared waypoints, chat/task marks, then teammates.
  'team-rally-area',
  'team-rally-edge',
  'team-trl-casing',
  'team-trl-line',
  'team-trl-vertex',
  'team-trl-who',
  'team-rally-dot',
  'team-rally-label',
  'team-waypoint-dot',
  'team-waypoint-label',
  'team-mark-cluster',
  'team-mark-pin',
  'team-mark-pin-badge',
  'team-mark-bubble',
  'team-mark-cluster-count',
  'team-mark-pin-initials',
  'team-mark-pin-count',
  'team-mark-bubble-count',
  'team-mark-task',
  'team-member-halo',
  'team-member-dot',
  'team-member-initials',
  'team-member-label',
  // 5. Move mode (#676).
  'waypoint-move-line',
  'waypoint-move-from-halo',
  'waypoint-move-from',
  // 6. Trail photos (#587; one anchor per kind, shared by every instance),
  // then the waypoint pins (#675).
  'trail-photos',
  'trail-photos-count',
  'trail-photos-selected-ring',
  'trail-photos-selected',
  'waypoint-pin',
  'waypoint-pin-photo',
  'waypoint-pin-label',
  // 7. A teammate's SOS.
  'team-sos-halo',
  'team-sos-dot',
  'team-sos-label',
  // 8. The puck itself: always on top.
  'inukshuk-puck-ring',
  'inukshuk-puck-dot',
] as const;

export type LiveLayerId = (typeof LIVE_LAYER_ORDER)[number];

const ANCHOR_PREFIX = 'live-anchor:';

/** The style's marker a live layer is inserted just below (`beforeId`). */
export function liveLayerAnchor(id: LiveLayerId): string {
  return `${ANCHOR_PREFIX}${id}`;
}

/** A live anchor as it appears in the style JSON: no source, never drawn. */
export interface LiveAnchorLayer {
  id: string;
  type: 'background';
  layout: { visibility: 'none' };
}

/** Every live anchor, bottom → top: the `live` slot of the style. */
export function liveAnchorLayers(): LiveAnchorLayer[] {
  return LIVE_LAYER_ORDER.map((id) => ({
    id: liveLayerAnchor(id),
    type: 'background',
    layout: { visibility: 'none' },
  }));
}

/**
 * What MapLibre ends up with: `style` (the style's layer ids, bottom → top)
 * after inserting `inserts` one by one, in the given order, each just below
 * its `beforeId` (`style.addLayerBelow`), or on top without one
 * (`style.addLayer`). For tests that replay a style reload; mirrors the
 * native semantics, it does not call them.
 */
export function replayInsertions(
  style: readonly string[],
  inserts: readonly { id: string; beforeId?: string }[],
): string[] {
  const out = [...style];
  for (const { id, beforeId } of inserts) {
    const at = beforeId === undefined ? -1 : out.indexOf(beforeId);
    if (at < 0) out.push(id);
    else out.splice(at, 0, id);
  }
  return out;
}
