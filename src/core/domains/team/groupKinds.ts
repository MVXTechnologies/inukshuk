import { isTeamId } from '@core/team/ids';
import { app, text } from '@core/group/fields';
import { KindTable } from '@core/group/kindTable';

/**
 * The team domain's 2.7.0 kind (`docs/design/sync-layer.md` §3.4, §5.2). An
 * unknown kind to a 2.6 phone, which stores, relays and skips it.
 * Forward-lenient on unknown fields (`@core/group/fields`). Validators only
 * in G1: nothing writes it yet. (`irdv` and `net` are group-level kinds,
 * `@core/group/meta`, so any group with its own room has them.)
 *
 * | kind | key | fields | who writes | who deletes |
 * |---|---|---|---|---|
 * | `gref` a child group (a folder shared with the team) | owned, id = the child group id | `app` (first write, then never changed), `name` | members | its writer or an admin |
 */
export const GREF = 'gref';
export const MAX_GROUP_NAME = 80;

export const TEAM_V27 = new KindTable({
  [GREF]: {
    owned: true,
    writes: (r) => r !== 'guest',
    id: isTeamId,
    rules: { app, name: text(MAX_GROUP_NAME) },
    first: 'app',
    once: ['app'],
  },
});

export const TEAM_V27_KINDS: readonly string[] = TEAM_V27.kinds;
