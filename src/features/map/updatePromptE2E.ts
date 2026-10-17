import { Platform } from 'react-native';
import { create } from 'zustand';

import {
  fakeStoreAnswer,
  parseUpdatePromptLink,
  type StoreOffer,
  type UpdatePhase,
} from '@core/app/storeUpdate';

/**
 * Review screenshots of the "New version" prompt (2.7.0) need an offer the
 * store will never make on a CI emulator. A build made with
 * `EXPO_PUBLIC_E2E_UPDATE_PROMPT=1` (the E2E workflow's build only, never a
 * store build) accepts `inukshuk://e2e/update-prompt?state=…` and shows that
 * state until the app process ends: nothing is persisted, the store is never
 * asked, and the buttons do nothing but close.
 *
 * Store builds: babel-preset-expo inlines `process.env.EXPO_PUBLIC_*` at build
 * time, so the flag is the constant `false` there and the link falls through
 * to routing like any unknown path.
 */
export const E2E_UPDATE_PROMPT = process.env.EXPO_PUBLIC_E2E_UPDATE_PROMPT === '1';

export interface FakeStoreAnswer {
  offer: StoreOffer;
  phase: UpdatePhase;
}

/** The faked answer for this launch, or null (always null outside E2E builds). */
export const useUpdatePromptFake = create<{ fake: FakeStoreAnswer | null }>(() => ({
  fake: null,
}));

/**
 * Called by `app/+native-intent.tsx` for every incoming link: true when it was
 * the E2E prompt link and the fake is now on (the caller lands on the Map).
 * `enabled` is the build flag; tests pass it explicitly.
 */
export function applyUpdatePromptLink(url: string, enabled: boolean = E2E_UPDATE_PROMPT): boolean {
  if (!enabled) return false;
  const state = parseUpdatePromptLink(url);
  if (state === null) return false;
  useUpdatePromptFake.setState({
    fake: fakeStoreAnswer(state, Platform.OS === 'ios' ? 'ios' : 'android'),
  });
  return true;
}
