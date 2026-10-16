/**
 * Share live on the Library screen (#712, G10 mockups 1–6, 10, 11): the
 * Share sheet's "Share live" row, the Share live sheet, a shared folder's
 * header line and faces, row notes, the folders being joined, the folder's
 * own sheet and the Leave / Stop sharing dialogs.
 */
import type { LocalKind } from '@core/domains/library/liveFields';
import { appLibraryBridge } from '@data/sync/libraryPort';
import type { LiveFolder } from '@data/sync/liveFolders';
import { appTeamService } from '@data/team/appTeam';
import { useLibraryStore } from '@state/libraryStore';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { LiveTarget } from '../selection/useLibrarySelection';
import { LeaveDialog, SharedFolderSheet, StopDialog } from './SharedFolderSheet';
import { ShareLiveSheet, type ShareLiveChoice } from './ShareLiveSheet';
import { refreshLive, rootShare, rowNoteOf, useLiveFolders } from './useLive';

/** My name in a new shared folder: the one I last used in a group (none: the panel asks once). */
function knownName(): string | undefined {
  const records = appTeamService()?.host.allRecords ?? [];
  return records.find((r) => r.myName)?.myName;
}

export function useShareLive(args: {
  focused: boolean;
  showSnack: (message: string) => void;
  /** Item counts per folder (the Leave dialog's "Remove it · 6 items"). */
  itemsIn: (folderId: string) => number;
  /** The folder sheet's "Send a copy": the Share sheet for the shared folder or item. */
  onSendCopy?: (target: LiveTarget) => void;
}) {
  const list = useLiveFolders();
  const router = useRouter();
  const [target, setTarget] = useState<LiveTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<LiveFolder | null>(null);
  const [stopping, setStopping] = useState<LiveFolder | null>(null);
  const { showSnack } = args;

  // A folder a teammate shared appears: say so once.
  const announced = useRef<Set<string> | null>(null);
  useEffect(() => {
    const joining = list.filter((f) => f.joining);
    if (announced.current === null) {
      announced.current = new Set(joining.map((f) => f.groupId));
      return;
    }
    for (const f of joining) {
      if (announced.current.has(f.groupId)) continue;
      announced.current.add(f.groupId);
      showSnack(`${f.sharedBy ?? 'A teammate'} shared ${f.name}`);
    }
  }, [list, showSnack]);

  const liveRow = (t: LiveTarget) => {
    if (appLibraryBridge() === null) return undefined;
    const shared = rootShare(list, t.kind, t.id);
    if (shared !== undefined) return { label: 'Shared live', detail: shared.subtitle };
    return {
      label: 'Share live',
      detail:
        t.kind === 'folder'
          ? 'Everyone can add and edit · syncs both ways'
          : 'Edits sync both ways',
    };
  };

  const onShareLive = (t: LiveTarget) => {
    const shared = rootShare(list, t.kind, t.id);
    if (shared !== undefined) setSheet(shared.groupId);
    else setTarget(t);
  };

  const start = async (choice: ShareLiveChoice) => {
    const bridge = appLibraryBridge();
    if (bridge === null || target === null) return;
    setBusy(true);
    try {
      const myName = choice.name ?? knownName();
      if (myName === undefined) return;
      const options = { myName };
      const r =
        target.kind === 'folder'
          ? await bridge.shareFolder(target.id, options)
          : await bridge.shareItem(target.kind, target.id, options);
      if (typeof r === 'string') showSnack('Could not start sharing');
      else {
        refreshLive();
        // Its own invite next (QR or link).
        router.push({
          pathname: '/shared/[id]/invite',
          params: {
            id: r.teamId,
            role: choice.canEdit ? 'member' : 'guest',
            expiry: choice.expiry,
            uses: String(choice.uses),
          },
        });
      }
    } finally {
      setBusy(false);
      setTarget(null);
    }
  };

  const open = list.find((f) => f.groupId === sheet) ?? null;
  const go = (path: 'people' | 'activity' | 'trash') => {
    if (open === null) return;
    setSheet(null);
    router.push(`/shared/${open.groupId}/${path}`);
  };

  const overlay: ReactNode = (
    <>
      <ShareLiveSheet
        visible={target !== null}
        focused={args.focused}
        subtitle={subtitleOf(target)}
        needsName={target !== null && knownName() === undefined}
        busy={busy}
        onStart={(c) => void start(c)}
        onClose={() => {
          if (!busy) setTarget(null);
        }}
      />
      <SharedFolderSheet
        folder={open}
        focused={args.focused}
        onPeople={() => go('people')}
        onActivity={() => go('activity')}
        onTrash={() => go('trash')}
        {...(args.onSendCopy !== undefined && open?.local !== undefined
          ? {
              onSendCopy: () => {
                const local = open.local!;
                setSheet(null);
                args.onSendCopy!(local);
              },
            }
          : {})}
        onStop={() => {
          setStopping(open);
          setSheet(null);
        }}
        onLeave={() => {
          setLeaving(open);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      <LeaveDialog
        name={leaving?.name ?? null}
        items={leaving?.local?.kind === 'folder' ? args.itemsIn(leaving.local.id) : 1}
        onCancel={() => setLeaving(null)}
        onLeave={(keep) => {
          const f = leaving;
          setLeaving(null);
          if (f === null) return;
          void appLibraryBridge()
            ?.leave(f.groupId, keep)
            .then(() => {
              showSnack(`Left ${f.name}`);
              refreshLive();
            });
        }}
      />
      <StopDialog
        name={stopping?.name ?? null}
        onCancel={() => setStopping(null)}
        onStop={() => {
          const f = stopping;
          setStopping(null);
          if (f === null) return;
          void appLibraryBridge()
            ?.stopSharing(f.groupId)
            .then((err) => {
              showSnack(err === null ? `Stopped sharing ${f.name}` : 'Could not stop sharing');
              refreshLive();
            });
        }}
      />
    </>
  );

  return {
    list,
    liveRow,
    onShareLive,
    /** The folder's ⋮ (its own sheet). */
    openSheet: (groupId: string) => setSheet(groupId),
    /** A Library folder that is a shared folder's root. */
    folderShare: (folderId: string) => rootShare(list, 'folder', folderId),
    /** The share an item is the root of ("Live with Alex"). */
    itemShare: (kind: LocalKind, id: string) => rootShare(list, kind, id),
    note: (kind: LocalKind, id: string) => rowNoteOf(list, kind, id),
    joining: list.filter((f) => f.joining),
    overlay,
    /** A sheet or dialog of Share live is up (the screen's Back goes to it). */
    open: target !== null || sheet !== null || leaving !== null || stopping !== null,
  };
}

function subtitleOf(target: LiveTarget | null): string {
  if (target === null) return '';
  const s = useLibraryStore.getState();
  const name =
    target.kind === 'folder'
      ? s.folders.find((f) => f.id === target.id)?.name
      : target.kind === 'waypoint'
        ? s.waypoints.find((w) => w.id === target.id)?.label
        : target.kind === 'area'
          ? s.areas.find((a) => a.id === target.id)?.name
          : target.kind === 'track'
            ? s.tracks.find((x) => x.id === target.id)?.name
            : s.maps.find((m) => m.id === target.id)?.name;
  if (target.kind === 'folder') return `${name ?? 'This folder'} · and anything added later`;
  return name ?? '';
}
