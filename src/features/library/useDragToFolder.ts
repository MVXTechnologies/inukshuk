import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  StatusBar,
  type ScrollView,
  type View,
} from 'react-native';

export interface DragItem {
  kind: 'map' | 'track' | 'waypoint';
  id: string;
  label: string;
}

/** A drop target key: a folder id, or null for the Ungrouped header. */
export type DropTargetKey = string | null;

const EDGE_ZONE_PX = 96;
const AUTO_SCROLL_STEP = 14;
const MEASURE_THROTTLE_MS = 120;

/** Map-key encoding: the null (Ungrouped) target needs a stable string key. */
const keyOf = (target: DropTargetKey) => (target === null ? ' ungrouped' : target);
const fromKey = (key: string): DropTargetKey => (key === ' ungrouped' ? null : key);

/**
 * Drag-a-card-onto-a-folder-header support for the Library. One shared
 * PanResponder lives on every card's drag handle; a touch on a handle arms
 * `pendingItemRef` (identity travels out-of-band — responder events carry no
 * payload), the grant starts the drag, moves steer a ghost chip through an
 * Animated.ValueXY (no re-render per move), and the release drops onto
 * whichever registered header rect contains the finger. Header rects are
 * re-measured (throttled) during the drag because auto-scroll shifts them.
 * The ScrollView must set `scrollEnabled={dragging === null}`.
 *
 * Built with lazy useState initializers (not `useRef(...).current`) so no ref
 * is touched during render — all mutable state lives in refs read/written
 * only inside responder callbacks.
 */
export function useDragToFolder({
  onDrop,
}: {
  onDrop: (item: DragItem, target: DropTargetKey) => void;
}) {
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [hovered, setHovered] = useState<DropTargetKey | 'none'>('none');
  const [ghost] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));

  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  const pendingItemRef = useRef<DragItem | null>(null);
  const draggingRef = useRef<DragItem | null>(null);
  const hoveredRef = useRef<DropTargetKey | 'none'>('none');
  const targetsRef = useRef(new Map<string, View>());
  const rectsRef = useRef(new Map<string, { x: number; y: number; w: number; h: number }>());
  const lastMeasureRef = useRef(0);
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollYRef = useRef(0);
  const windowHRef = useRef(0);
  const autoScrollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Attach to a folder (or Ungrouped) header View via `ref`. */
  const registerTarget = useCallback((target: DropTargetKey) => {
    const key = keyOf(target);
    return (view: View | null) => {
      if (view) targetsRef.current.set(key, view);
      else targetsRef.current.delete(key);
    };
  }, []);

  const [dragMachine] = useState(() => {
    const measureTargets = () => {
      lastMeasureRef.current = Date.now();
      // Touch pageY is SCREEN-relative but Android's measureInWindow excludes
      // the status bar — shift rects into touch space or every hit-test aims
      // one status-bar-height too low (the bug that ate the first drops).
      const statusBar = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;
      for (const [key, view] of targetsRef.current) {
        view.measureInWindow((x, y, w, h) => {
          rectsRef.current.set(key, { x, y: y + statusBar, w, h });
        });
      }
    };

    const hitTest = (pageX: number, pageY: number): DropTargetKey | 'none' => {
      for (const [key, r] of rectsRef.current) {
        if (pageX >= r.x && pageX <= r.x + r.w && pageY >= r.y && pageY <= r.y + r.h) {
          return fromKey(key);
        }
      }
      return 'none';
    };

    const stopAutoScroll = () => {
      if (autoScrollRef.current !== null) {
        clearInterval(autoScrollRef.current);
        autoScrollRef.current = null;
      }
    };

    const endDrag = (commit: boolean, pageX: number, pageY: number) => {
      stopAutoScroll();
      const item = draggingRef.current;
      draggingRef.current = null;
      pendingItemRef.current = null;
      setDragging(null);
      setHovered('none');
      hoveredRef.current = 'none';
      if (!commit || !item) return;
      const target = hitTest(pageX, pageY);
      if (target !== 'none') onDropRef.current(item, target);
    };

    // One responder per handle, item identity bound in the closure via a
    // mutable box (renames update it on the next render's getHandleProps).
    // Claiming at touch-DOWN is what beats the ScrollView: negotiation happens
    // before onTouchStart, so an out-of-band arming ref can never win — by the
    // time moves arrive, Android's native scroll has already cancelled us.
    const responders = new Map<string, { box: { item: DragItem }; handlers: object }>();

    const getHandleProps = (item: DragItem) => {
      const key = `${item.kind}:${item.id}`;
      let entry = responders.get(key);
      if (!entry) {
        const box = { item };
        const responder = PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderTerminationRequest: () => false,
          onShouldBlockNativeResponder: () => true,
          onPanResponderGrant: (e) => {
            pendingItemRef.current = box.item;
            ghost.setValue({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
          },
          onPanResponderMove: (e, gesture) => {
            const armed = pendingItemRef.current;
            if (!draggingRef.current) {
              // A plain tap must not flash the ghost — activate on movement.
              if (!armed || Math.abs(gesture.dx) + Math.abs(gesture.dy) < 6) return;
              draggingRef.current = armed;
              setDragging(armed);
              measureTargets();
            }
            const { pageX, pageY } = e.nativeEvent;
            ghost.setValue({ x: pageX, y: pageY });
            if (Date.now() - lastMeasureRef.current > MEASURE_THROTTLE_MS) measureTargets();
            const hit = hitTest(pageX, pageY);
            if (hit !== hoveredRef.current) {
              hoveredRef.current = hit;
              setHovered(hit);
            }
            const h = windowHRef.current;
            const dir = pageY < EDGE_ZONE_PX ? -1 : h > 0 && pageY > h - EDGE_ZONE_PX ? 1 : 0;
            if (dir === 0) stopAutoScroll();
            else if (autoScrollRef.current === null) {
              autoScrollRef.current = setInterval(() => {
                scrollYRef.current = Math.max(0, scrollYRef.current + dir * AUTO_SCROLL_STEP);
                scrollRef.current?.scrollTo({ y: scrollYRef.current, animated: false });
              }, 32);
            }
          },
          onPanResponderRelease: (e) => endDrag(true, e.nativeEvent.pageX, e.nativeEvent.pageY),
          onPanResponderTerminate: (e) => endDrag(false, e.nativeEvent.pageX, e.nativeEvent.pageY),
        });
        entry = { box, handlers: responder.panHandlers };
        responders.set(key, entry);
      }
      entry.box.item = item;
      return entry.handlers;
    };

    return { getHandleProps };
  });

  /** Spread onto each card's drag-handle View, with that card's item. */
  const handleProps = useCallback(
    (item: DragItem) => dragMachine.getHandleProps(item),
    [dragMachine],
  );

  const onScroll = useCallback((y: number) => {
    scrollYRef.current = y;
  }, []);
  const onWindowHeight = useCallback((h: number) => {
    windowHRef.current = h;
  }, []);

  return {
    dragging,
    hovered,
    ghost,
    registerTarget,
    handleProps,
    scrollRef,
    onScroll,
    onWindowHeight,
  };
}
