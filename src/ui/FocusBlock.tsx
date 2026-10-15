import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

/**
 * A container whose subtree can never take focus (#715), for the app's
 * always-mounted hidden WebViews (PDF rasterizer, photo resizer). On Android,
 * when a focused text field leaves the screen, the system hands focus to the
 * first view focusable in touch mode — one of those WebViews — and the soft
 * keyboard stays up for it (Explore › Add to Library › New folder… › Create).
 * `Keyboard.dismiss()` cannot help then: it only blurs an RN text field, and
 * none is focused. The native view (`modules/inukshuk-focus-block`) blocks
 * focus at the source.
 *
 * A plain View on iOS (WKWebView never takes the first responder unasked),
 * and wherever the native view is absent.
 */
export function resolveFocusBlock(
  os: string,
  native: {
    optional: (name: string) => unknown;
    view: (name: string) => ComponentType<ViewProps>;
  },
): ComponentType<ViewProps> {
  if (os !== 'android') return View;
  try {
    if (native.optional('InukshukFocusBlock') === null) return View;
    return native.view('InukshukFocusBlock');
  } catch {
    return View;
  }
}

export const FocusBlock: ComponentType<ViewProps> = resolveFocusBlock(Platform.OS, {
  optional: requireOptionalNativeModule,
  view: (name) => requireNativeView<ViewProps>(name),
});
