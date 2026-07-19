/* eslint-disable react-hooks/refs -- The PanResponder idiom: the lazy
   useState initializer builds one responder whose callbacks read/write refs.
   Every `.current` access happens inside responder/event callbacks (never
   during render); the initializer only captures the stable ref objects. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, type ScrollView, type View } from 'react-native';

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

  const [panResponder] = useState(() => {
    const measureTargets = () => {
      lastMeasureRef.current = Date.now();
      for (const [key, view] of targetsRef.current) {
        view.measureInWindow((x, y, w, h) => {
          rectsRef.current.set(key, { x, y, w, h });
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

    return PanResponder.create({
      onStartShouldSetPanResponder: () => pendingItemRef.current !== null,
      onMoveShouldSetPanResponder: () => pendingItemRef.current !== null,
      onPanResponderGrant: (e) => {
        const item = pendingItemRef.current;
        if (!item) return;
        draggingRef.current = item;
        setDragging(item);
        ghost.setValue({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
        measureTargets();
      },
      onPanResponderMove: (e) => {
        if (!draggingRef.current) return;
        const { pageX, pageY } = e.nativeEvent;
        ghost.setValue({ x: pageX, y: pageY });
        if (Date.now() - lastMeasureRef.current > MEASURE_THROTTLE_MS) measureTargets();
        const hit = hitTest(pageX, pageY);
        if (hit !== hoveredRef.current) {
          hoveredRef.current = hit;
          setHovered(hit);
        }
        // Auto-scroll while hovering the screen's top/bottom edge zones.
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
  });

  /** Spread onto each card's drag-handle View, with that card's item. */
  const handleProps = useCallback(
    (item: DragItem) => ({
      onTouchStart: () => {
        pendingItemRef.current = item;
      },
      onTouchEnd: () => {
        if (!draggingRef.current) pendingItemRef.current = null;
      },
      ...panResponder.panHandlers,
    }),
    [panResponder],
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
