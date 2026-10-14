import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether TalkBack / VoiceOver is on, kept current: asked once on mount and
 * then followed through `screenReaderChanged`, so a control meant only for
 * screen-reader users appears and disappears as the user toggles it. False
 * until the first answer (nothing extra is drawn for sighted users meanwhile).
 */
export function useScreenReaderEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (live) setEnabled(on);
      })
      .catch(() => undefined); // unknown: stay off, the change event still arrives
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (on: boolean) =>
      setEnabled(on),
    );
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return enabled;
}
