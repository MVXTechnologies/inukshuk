import type { LiveFolder } from '@data/sync/liveFolders';

import { SectionHeader } from '../components/LibraryChrome';

/**
 * Folders a teammate shared that this phone is picking up (#712, G10 mockup
 * 5): a shared folder header with a spinner and "Joining · from Julie",
 * above the list until the folder arrives and takes its place.
 */
export function JoiningFolders({ folders }: { folders: readonly LiveFolder[] }) {
  if (folders.length === 0) return null;
  return (
    <>
      {folders.map((f, i) => (
        <SectionHeader
          key={f.groupId}
          title={f.name}
          count=""
          first={i === 0}
          collapsed
          onToggle={() => undefined}
          live={{ line: f.line.text, tone: 'join', faces: f.faces }}
        />
      ))}
    </>
  );
}
