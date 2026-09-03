/**
 * The playground's formatters, bound to the unit system it was opened with.
 *
 * `@core/format` is pure: every unit-dependent formatter there takes the unit
 * system as an argument, and `createFormatters` binds them to one system. This
 * module is the playground's equivalent of the app's `src/state/formatters.ts`
 * — the one place that knows where units come from — so the cards keep their
 * terse `formatDistance(meters)` shape.
 *
 * The app's binding reads `settingsStore.units`; the playground has no Zustand
 * store and must not import one (`@state/formatters` would drag the whole app
 * store, and with it `react-native`, into the browser bundle). Its units come
 * from `?units=` instead — read once, at module load, exactly like the app's
 * old `setDisplayUnits()` call on hydrate. There is no in-session unit toggle,
 * so a single binding is the whole story; add one and this becomes a hook.
 */

import { createFormatters, type Units } from '@core/format';

import { readUrlState } from './urlState';

export { formatBytes, formatDuration, formatTimestamp, headingToCardinal } from '@core/format';
export type { Units } from '@core/format';

/** The unit system this page was opened with. Metric unless `?units=imperial`. */
export const UNITS: Units = readUrlState(window.location.search).units ?? 'metric';

export const { formatDistance, formatElevation, formatSpeed, formatPace } = createFormatters(UNITS);
