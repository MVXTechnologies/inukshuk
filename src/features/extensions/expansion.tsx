/**
 * Which Settings → Extensions entry shows its details. Every entry is a
 * one-line row by default; tapping it expands its details inline. One at a
 * time (an accordion): the details can be long (coverage lists, offline
 * options), so a second open entry would push the first off screen anyway,
 * and the list stays a scannable column of one-liners as extensions are
 * added. Nothing is persisted: every visit starts collapsed, except a deep
 * link naming an extension (`extensionSettingsHref`), which opens it.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { LayoutAnimation } from 'react-native';

interface Expansion {
  open: string | null;
  toggle: (key: string) => void;
}

const ExpansionContext = createContext<Expansion | null>(null);

/** The short open/close reflow of the list (skipped with reduce motion on). */
function animateReflow(reduceMotion: boolean): void {
  if (reduceMotion) return;
  LayoutAnimation.configureNext(LayoutAnimation.create(200, 'easeInEaseOut', 'opacity'));
}

/** Holds the one open entry of the section; `initialOpen` comes from a deep link. */
export function ExtensionExpansionProvider({
  initialOpen,
  reduceMotion,
  children,
}: {
  initialOpen?: string | null;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  const toggle = useCallback(
    (key: string) => {
      animateReflow(reduceMotion);
      setOpen((o) => (o === key ? null : key));
    },
    [reduceMotion],
  );
  const value = useMemo(() => ({ open, toggle }), [open, toggle]);
  return <ExpansionContext.Provider value={value}>{children}</ExpansionContext.Provider>;
}

/**
 * Whether entry `key` shows its details, and the toggle. Outside a provider
 * (an entry rendered alone, in a test) the entry keeps its own state.
 */
export function useExtensionExpanded(key: string): [boolean, () => void] {
  const shared = useContext(ExpansionContext);
  const [own, setOwn] = useState(false);
  const toggleOwn = useCallback(() => setOwn((o) => !o), []);
  const toggleShared = useCallback(() => shared?.toggle(key), [shared, key]);
  if (shared === null) return [own, toggleOwn];
  return [shared.open === key, toggleShared];
}

/**
 * Settings → Extensions with `key` open: for links from elsewhere in the app
 * (a receiver's grid download, a coverage note) to the extension's details.
 */
export function extensionSettingsHref(key: string) {
  return { pathname: '/settings', params: { open: 'extensions', ext: key } } as const;
}
