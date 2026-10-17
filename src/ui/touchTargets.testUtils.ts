/**
 * Touch-target audit for render tests (#760): every pressable in a rendered
 * tree whose box is sized explicitly must reach 48 dp on both axes once its
 * hitSlop is added. Boxes sized by their content (no width/height in their
 * style) can't be measured without layout and are not judged here.
 */
import { MIN_TOUCH } from '@core/display/displayScale';
import { StyleSheet } from 'react-native';

interface HostNode {
  type: unknown;
  props: Record<string, unknown>;
  children: (HostNode | string)[];
}

type Slop = number | { top?: number; bottom?: number; left?: number; right?: number } | undefined;

function slopOf(s: Slop) {
  if (typeof s === 'number') return { v: 2 * s, h: 2 * s };
  return { v: (s?.top ?? 0) + (s?.bottom ?? 0), h: (s?.left ?? 0) + (s?.right ?? 0) };
}

function isPressable(p: Record<string, unknown>): boolean {
  return typeof p.onClick === 'function' || typeof p.onResponderRelease === 'function';
}

/** The pressables under `root` drawn smaller than 48 dp even with their hitSlop. */
export function smallTouchTargets(root: HostNode): string[] {
  const out: string[] = [];
  const walk = (n: HostNode | string) => {
    if (typeof n === 'string') return;
    if (isPressable(n.props)) {
      const st = (StyleSheet.flatten(n.props.style as never) ?? {}) as Record<string, unknown>;
      const slop = slopOf(n.props.hitSlop as Slop);
      const name = String(
        n.props.accessibilityLabel ?? n.props.testID ?? n.props['aria-label'] ?? '?',
      );
      const h =
        typeof st.height === 'number'
          ? st.height
          : typeof st.minHeight === 'number'
            ? st.minHeight
            : null;
      const w =
        typeof st.width === 'number'
          ? st.width
          : typeof st.minWidth === 'number'
            ? st.minWidth
            : null;
      if (h !== null && h + slop.v < MIN_TOUCH) out.push(`${name}: height ${h} + slop ${slop.v}`);
      if (w !== null && w + slop.h < MIN_TOUCH) out.push(`${name}: width ${w} + slop ${slop.h}`);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** How many pressables the tree holds (so an audit can't pass on an empty tree). */
export function pressableCount(root: HostNode): number {
  let n = 0;
  const walk = (node: HostNode | string) => {
    if (typeof node === 'string') return;
    if (isPressable(node.props)) n += 1;
    for (const c of node.children ?? []) walk(c);
  };
  walk(root);
  return n;
}
