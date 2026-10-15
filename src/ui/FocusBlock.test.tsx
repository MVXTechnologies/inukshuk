import { readFileSync } from 'fs';
import { join } from 'path';
import { View } from 'react-native';

import { resolveFocusBlock } from './FocusBlock';

/**
 * #715 — the hidden WebViews sit in a native container that blocks focus on
 * Android, so a field leaving the screen cannot hand them the keyboard.
 */
const NativeBlock = () => null;
const native = (present: boolean) => ({
  optional: jest.fn((_name: string) => (present ? {} : null)),
  view: jest.fn((_name: string) => NativeBlock),
});

describe('FocusBlock', () => {
  it('is the native focus-blocking container on Android', () => {
    const n = native(true);
    expect(resolveFocusBlock('android', n)).toBe(NativeBlock);
    expect(n.view).toHaveBeenCalledWith('InukshukFocusBlock');
  });

  it('falls back to a plain View without the native view, and on iOS', () => {
    expect(resolveFocusBlock('android', native(false))).toBe(View);
    const throwing = {
      optional: () => ({}),
      view: () => {
        throw new Error('no view config');
      },
    };
    expect(resolveFocusBlock('android', throwing)).toBe(View);
    const n = native(true);
    expect(resolveFocusBlock('ios', n)).toBe(View);
    expect(n.view).not.toHaveBeenCalled();
  });

  it('wraps both always-mounted hidden WebViews', () => {
    for (const file of ['features/map/PdfRasterizer.tsx', 'features/photos/PhotoResizeHost.tsx']) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8');
      expect({ file, wrapped: /<FocusBlock[^>]*>\s*<WebView/.test(src) }).toEqual({
        file,
        wrapped: true,
      });
    }
  });
});
