import { Platform, type TextStyle } from 'react-native';

/**
 * Atkinson Hyperlegible Next (Braille Institute, SIL OFL 1.1 — see
 * `assets/fonts/OFL.txt`), embedded natively by the `expo-font` config plugin
 * in `app.config.ts` at weights 400, 500, 700 and 800. Weight is picked with
 * `fontWeight`, as with the system font:
 *
 * - iOS resolves the family by the name inside the font files;
 * - Android gets an XML font family under the name the plugin declares.
 *
 * Keep the weight list in sync with `app.config.ts`. 600 (used by some
 * boards) is not bundled; it falls to 700.
 */
export const FONT_FAMILY = Platform.select({
  ios: 'Atkinson Hyperlegible Next',
  default: 'AtkinsonHyperlegibleNext',
});

export const BUNDLED_FONT_WEIGHTS = [400, 500, 700, 800] as const;

/** Every number on screen uses tabular figures, so digits don't jitter as values tick. */
export const tabularNums: TextStyle = { fontVariant: ['tabular-nums'] };
