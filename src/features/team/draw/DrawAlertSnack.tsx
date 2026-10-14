/**
 * "Julie is drawing on the map · SHOW" (#683, mockup frame 7): once per author
 * per drawing session (`@core/teamdraw/alerts`). SHOW frames her shapes.
 * The timer is `useTimedSnackbar`'s own (never Paper's Snackbar, which sticks
 * on One UI); the view is the plain `ActionSnackbar`.
 */
import { ActionSnackbar } from '@features/common/ActionSnackbar';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { useTeamDrawStore } from '@state/teamDrawStore';
import { useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { showAuthor } from './drawShared';

export const DRAW_SNACK_MS = 4_000;

export function DrawAlertSnack({ style }: { style?: StyleProp<ViewStyle> }) {
  const announced = useTeamDrawStore((s) => s.announced);
  const { message, show, dismiss } = useTimedSnackbar(DRAW_SNACK_MS);
  const seq = announced?.seq;
  useEffect(() => {
    if (announced === null) return;
    const first = announced.name.split(' ')[0] ?? announced.name;
    show(announced.faded ? `${first}’s drawings have faded` : `${first} is drawing on the map`);
    // One show per announcement (its seq), not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);
  if (message === null) return null;
  const who = announced !== null && !announced.faded ? announced.author : null;
  return (
    <ActionSnackbar
      style={style}
      snack={{
        message,
        seq: seq ?? 0,
        actions:
          who === null
            ? []
            : [
                {
                  label: 'Show',
                  onPress: () => {
                    dismiss();
                    showAuthor(who);
                  },
                },
              ],
      }}
    />
  );
}
