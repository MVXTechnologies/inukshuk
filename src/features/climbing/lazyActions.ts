/**
 * The climbing actions, loaded on first use: they pull in the offline-pack
 * machinery (MapLibre's native modules, the loopback server), which screens
 * that only list saved crags (the Library shelf, Settings) need not load —
 * nor their tests.
 */
export const climbingActions = () => import('./climbingActions');
