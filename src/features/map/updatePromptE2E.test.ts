import { Platform } from 'react-native';

import { E2E_UPDATE_PROMPT, applyUpdatePromptLink, useUpdatePromptFake } from './updatePromptE2E';

const LINK = 'inukshuk://e2e/update-prompt?state=downloading';

beforeEach(() => {
  useUpdatePromptFake.setState({ fake: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the E2E update-prompt switch is off outside E2E builds', () => {
  it('the flag is off when the build sets no EXPO_PUBLIC_E2E_UPDATE_PROMPT', () => {
    expect(process.env.EXPO_PUBLIC_E2E_UPDATE_PROMPT).toBeUndefined();
    expect(E2E_UPDATE_PROMPT).toBe(false);
  });

  it('with the build flag off, the link does nothing', () => {
    expect(applyUpdatePromptLink(LINK)).toBe(false);
    expect(applyUpdatePromptLink(LINK, false)).toBe(false);
    expect(useUpdatePromptFake.getState().fake).toBeNull();
  });

  it('reads the flag as exactly "1"', () => {
    // The module reads process.env once, as the inlined build constant would.
    for (const [value, on] of [
      ['1', true],
      ['0', false],
      ['true', false],
      ['', false],
    ] as const) {
      jest.isolateModules(() => {
        const before = process.env.EXPO_PUBLIC_E2E_UPDATE_PROMPT;
        process.env.EXPO_PUBLIC_E2E_UPDATE_PROMPT = value;
        try {
          const mod = jest.requireActual<typeof import('./updatePromptE2E')>('./updatePromptE2E');
          expect(mod.E2E_UPDATE_PROMPT).toBe(on);
        } finally {
          if (before === undefined) delete process.env.EXPO_PUBLIC_E2E_UPDATE_PROMPT;
          else process.env.EXPO_PUBLIC_E2E_UPDATE_PROMPT = before;
        }
      });
    }
  });
});

describe('in an E2E build', () => {
  it('fakes the linked state for this launch, worded for the platform', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    expect(applyUpdatePromptLink(LINK, true)).toBe(true);
    expect(useUpdatePromptFake.getState().fake).toEqual({
      offer: { platform: 'android', versionCode: 999_999 },
      phase: { kind: 'downloading', fraction: 0.42 },
    });
    jest.replaceProperty(Platform, 'OS', 'ios');
    expect(applyUpdatePromptLink('inukshuk://e2e/update-prompt?state=available', true)).toBe(true);
    expect(useUpdatePromptFake.getState().fake?.offer).toEqual({
      platform: 'ios',
      version: '2.7.1',
      trackId: 1,
    });
  });

  it('ignores every other link', () => {
    expect(applyUpdatePromptLink('inukshuk://convert?a=1', true)).toBe(false);
    expect(applyUpdatePromptLink('inukshuk://e2e/update-prompt?state=bogus', true)).toBe(false);
    expect(useUpdatePromptFake.getState().fake).toBeNull();
  });
});
