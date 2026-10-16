import { fnv1a32 } from '@core/encoding/fnv1a';

import { photoScaleAt } from './mapStyle';

/**
 * Trail notes on the trail view's map (#742, owner pick "Option 1 · photo
 * ring"): a note with a photo shows its photo as a circle on the trail —
 * the same look as every trail photo — with its green number badge on the
 * circle's top-right edge; a note without one keeps its plain numbered pin.
 *
 * The circle is a resized round sprite (the trail photos' 264 px
 * `.map2.png`, made once per photo and cached), never the full-size note
 * photo. Until it exists, the note shows its plain pin. The circle grows
 * with the zoom like the trail photos (`photoScaleAt`); the badge follows
 * the Pin size setting.
 *
 * PURE: no React Native / Expo imports.
 */

/** The round photo circles' diameter at scale 1 (dp): 264 px sprites at 6 px/dp. */
export const PHOTO_CIRCLE_DP = 44;
/** The numbered badge's diameter at 100 % pin size (dp). */
export const NOTE_BADGE_DP = 24;
/** A plain note pin's tap radius (dp). */
export const NOTE_HIT_DP = 48;

/** The cached sprite's file name for a note photo (stable per photo file). */
export function noteSpriteName(photoUri: string): string {
  return `note-${fnv1a32(photoUri)}.map2.png`;
}

export type NotePinKind = { kind: 'photo'; sprite: string } | { kind: 'pin' };

/**
 * How each note is drawn: its photo circle when it has a photo whose sprite
 * is ready (`spriteFor`), else its plain pin.
 */
export function notePinKind(
  note: { photoUri?: string | undefined },
  spriteFor: (photoUri: string) => string | null | undefined,
): NotePinKind {
  if (!note.photoUri) return { kind: 'pin' };
  const sprite = spriteFor(note.photoUri);
  return sprite ? { kind: 'photo', sprite } : { kind: 'pin' };
}

/** The note photos that still need a sprite (each photo once). */
export function missingNoteSprites(
  notes: readonly { photoUri?: string | undefined }[],
  spriteFor: (photoUri: string) => string | null | undefined,
): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (n.photoUri && !spriteFor(n.photoUri) && !out.includes(n.photoUri)) out.push(n.photoUri);
  }
  return out;
}

export interface NotePhotoPinLayout {
  /** The photo circle's diameter (dp). */
  diameter: number;
  /** The badge's diameter (dp). */
  badge: number;
  /** The badge centre relative to the circle centre: on its top-right edge (dp). */
  badgeX: number;
  badgeY: number;
  /** A tap within this distance of the note's point opens it (dp). */
  hitRadius: number;
}

/** A photo note's circle and badge at `zoom`, with the Pin size factor `pinScale`. */
export function notePhotoPinLayout(zoom: number, pinScale: number): NotePhotoPinLayout {
  const diameter = PHOTO_CIRCLE_DP * photoScaleAt(zoom);
  const badge = NOTE_BADGE_DP * pinScale;
  const r = diameter / 2;
  const edge = r * Math.SQRT1_2;
  return {
    diameter,
    badge,
    badgeX: edge,
    badgeY: -edge,
    hitRadius: Math.max(NOTE_HIT_DP, r + badge),
  };
}

/** A plain note pin's tap radius with the Pin size factor. */
export function notePinHitRadius(pinScale: number): number {
  return Math.max(NOTE_HIT_DP, NOTE_BADGE_DP * pinScale);
}
