import { photoScaleAt } from './mapStyle';
import {
  missingNoteSprites,
  NOTE_BADGE_DP,
  NOTE_HIT_DP,
  noteSpriteName,
  notePhotoPinLayout,
  notePinHitRadius,
  notePinKind,
  PHOTO_CIRCLE_DP,
} from './notePins';

describe('note pins (#742, photo ring)', () => {
  const sprites: Record<string, string> = { 'file:///p/a.jpg': 'file:///cache/a.map2.png' };
  const spriteFor = (uri: string) => sprites[uri] ?? null;

  it('a note with a ready sprite is a photo circle; without photo or sprite, a plain pin', () => {
    expect(notePinKind({ photoUri: 'file:///p/a.jpg' }, spriteFor)).toEqual({
      kind: 'photo',
      sprite: 'file:///cache/a.map2.png',
    });
    expect(notePinKind({}, spriteFor)).toEqual({ kind: 'pin' });
    expect(notePinKind({ photoUri: 'file:///p/b.jpg' }, spriteFor)).toEqual({ kind: 'pin' });
  });

  it('never uses the full-size photo as the circle', () => {
    const kind = notePinKind({ photoUri: 'file:///p/a.jpg' }, spriteFor);
    expect(kind.kind === 'photo' && kind.sprite).not.toBe('file:///p/a.jpg');
    // The sprite name says 6 px per point (`spritePixelRatio`).
    expect(noteSpriteName('file:///p/b.jpg')).toMatch(/\.map2\.png$/);
  });

  it('lists each photo still missing its sprite once', () => {
    expect(
      missingNoteSprites(
        [
          { photoUri: 'file:///p/a.jpg' },
          { photoUri: 'file:///p/b.jpg' },
          {},
          { photoUri: 'file:///p/b.jpg' },
        ],
        spriteFor,
      ),
    ).toEqual(['file:///p/b.jpg']);
  });

  it('names sprites stably per photo file', () => {
    expect(noteSpriteName('file:///p/a.jpg')).toBe(noteSpriteName('file:///p/a.jpg'));
    expect(noteSpriteName('file:///p/a.jpg')).not.toBe(noteSpriteName('file:///p/b.jpg'));
    expect(noteSpriteName('file:///p/a.jpg')).toMatch(/^note-[0-9a-z]+\.map2\.png$/);
  });

  it('grows the circle with the zoom like the trail photos', () => {
    expect(notePhotoPinLayout(12, 1).diameter).toBeCloseTo(PHOTO_CIRCLE_DP * photoScaleAt(12));
    expect(notePhotoPinLayout(18.5, 1).diameter).toBeGreaterThan(
      notePhotoPinLayout(14, 1).diameter,
    );
  });

  it('puts the badge on the circle’s top-right edge, sized by Pin size', () => {
    const l = notePhotoPinLayout(15, 1);
    expect(Math.hypot(l.badgeX, l.badgeY)).toBeCloseTo(l.diameter / 2);
    expect(l.badgeX).toBeGreaterThan(0);
    expect(l.badgeY).toBeLessThan(0);
    expect(l.badge).toBe(NOTE_BADGE_DP);
    expect(notePhotoPinLayout(15, 1.5).badge).toBe(NOTE_BADGE_DP * 1.5);
  });

  it('a tap on the circle or its badge opens the note', () => {
    const big = notePhotoPinLayout(18.5, 1.5);
    expect(big.hitRadius).toBeGreaterThanOrEqual(big.diameter / 2 + big.badge);
    expect(notePhotoPinLayout(12, 1).hitRadius).toBe(NOTE_HIT_DP);
    expect(notePinHitRadius(1)).toBe(NOTE_HIT_DP);
    expect(notePinHitRadius(3)).toBe(NOTE_BADGE_DP * 3);
  });
});
