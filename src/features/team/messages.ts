/** What to tell the user when a team action could not run (#589). */
import type { ActionError } from '@data/team/teamSession';
import type { JoinFailure } from '@data/team/teamJoin';

const ACTION: Record<ActionError, string> = {
  'read-only': 'This team has ended: it’s read-only.',
  'not-allowed': 'Only an admin can do that.',
  'rotation-pending':
    'Someone was removed and the team key hasn’t been rotated yet. An admin must rotate it first.',
  'not-member': 'You’re no longer a member of this team.',
  invalid: 'Check what you typed.',
  'too-large': 'That’s too large to share with the team.',
  'no-change': 'Nothing to change.',
};

export function actionMessage(err: string): string {
  return ACTION[err as ActionError] ?? 'Something went wrong.';
}

export const JOIN_FAILURE: Record<JoinFailure, { title: string; body: string }> = {
  expired: {
    title: 'This invite has expired',
    body: 'Ask a team admin for a new one.',
  },
  'no-mesh': {
    title: 'Team mode needs the app update',
    body: 'Update Inukshuk from the store to join teams.',
  },
  refused: {
    title: 'The team refused this invite',
    body: 'It may have been cancelled, or need an admin nearby. Ask for a new invite.',
  },
  used: {
    title: 'This invite was already used',
    body: 'Single-use invites work once. Ask a team admin for a new one.',
  },
  'not-found': {
    title: 'No teammate found nearby',
    body: 'Join the same Wi-Fi or hotspot as a teammate whose app is open.',
  },
  'local-network-denied': {
    title: 'Local Network is off for Inukshuk',
    body: 'Turn it on in Settings › Privacy & Security › Local Network to find your team.',
  },
};
