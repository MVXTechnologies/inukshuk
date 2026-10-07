/**
 * What the UI says when a trail's photo list cannot be written over (#587):
 * a sidecar from a newer app version, or one that cannot be read. Both block
 * adding, editing, moving and removing photos; the trail itself still works.
 */

export type PhotoListStatus = 'loading' | 'ok' | 'missing' | 'unreadable' | 'future' | 'error';

export const NEWER_VERSION_NOTICE =
  'These photos were saved by a newer version of Inukshuk. Update the app to add or change them.';
export const UNREADABLE_NOTICE =
  "This trail's photo list could not be read, so photos can't be added or changed. Nothing was deleted.";
const ERROR_NOTICE = "This trail's photos could not be loaded. Try again in a moment.";

/** The notice for a photo-list status, or null when photos can be edited (or are loading). */
export function photoListNotice(status: PhotoListStatus | undefined): string | null {
  switch (status) {
    case 'future':
      return NEWER_VERSION_NOTICE;
    case 'unreadable':
      return UNREADABLE_NOTICE;
    case 'error':
      return ERROR_NOTICE;
    default:
      return null;
  }
}

/**
 * The message for an edit refused by the data layer (`SidecarUnavailableError`
 * carries `status`), or a generic one for any other failure.
 */
export function photoEditFailureMessage(err: unknown, fallback: string): string {
  const status =
    err !== null && typeof err === 'object' && 'status' in err
      ? (err as { status: unknown }).status
      : undefined;
  if (status === 'future') return NEWER_VERSION_NOTICE;
  if (status === 'unreadable') return UNREADABLE_NOTICE;
  return fallback;
}
