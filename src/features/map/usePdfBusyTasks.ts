import { renderingPages } from '@core/library/renderingPages';
import { beginBusyTask, type BusyTaskHandle } from '@state/busyTasksStore';
import { useLibraryStore } from '@state/libraryStore';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { useEffect, useRef } from 'react';

/**
 * PDF pages in the rasterizer become busy tasks (#721; they were their own
 * "Rendering … page N" rows, #269): kind 'pdf', labelled with the page
 * ("p.2") and the map's name, from the moment the map asks for the page
 * until it is drawn, fails or leaves the active set. Mounted by the map
 * screen, the one place that waits on these renders.
 */
export function usePdfBusyTasks(): void {
  const maps = useLibraryStore((s) => s.maps);
  const statuses = useOverlayStatusStore((s) => s.statuses);
  const handlesRef = useRef(new Map<string, { handle: BusyTaskHandle; name: string }>());

  useEffect(() => {
    const handles = handlesRef.current;
    const live = new Set<string>();
    for (const p of renderingPages(maps, statuses)) {
      live.add(p.key);
      const held = handles.get(p.key);
      if (held === undefined) {
        const handle = beginBusyTask('pdf', { label: `p.${p.page}`, subject: p.name });
        handles.set(p.key, { handle, name: p.name });
      } else if (held.name !== p.name) {
        // Renamed mid-render.
        held.handle.update({ subject: p.name });
        held.name = p.name;
      }
    }
    for (const [key, held] of handles) {
      if (live.has(key)) continue;
      held.handle.finish();
      handles.delete(key);
    }
  }, [maps, statuses]);

  useEffect(() => {
    const handles = handlesRef.current;
    return () => {
      for (const held of handles.values()) held.handle.finish();
      handles.clear();
    };
  }, []);
}
