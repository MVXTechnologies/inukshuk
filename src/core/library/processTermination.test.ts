import {
  RESUME_GRACE_MS,
  appPhaseAt,
  terminationMessage,
  terminationVerdict,
} from './processTermination';

describe('appPhaseAt', () => {
  it('is background whenever the app is not in front', () => {
    expect(appPhaseAt({ foreground: false, activeSince: null }, 0)).toBe('background');
    expect(appPhaseAt({ foreground: false, activeSince: 0 }, 1)).toBe('background');
  });

  it('is resuming for a grace window after coming back, then active', () => {
    const since = 1_000;
    expect(appPhaseAt({ foreground: true, activeSince: since }, since)).toBe('resuming');
    expect(appPhaseAt({ foreground: true, activeSince: since }, since + RESUME_GRACE_MS - 1)).toBe(
      'resuming',
    );
    expect(appPhaseAt({ foreground: true, activeSince: since }, since + RESUME_GRACE_MS)).toBe(
      'active',
    );
  });

  it('is active for an app that never left the foreground', () => {
    expect(appPhaseAt({ foreground: true, activeSince: null }, 5)).toBe('active');
  });
});

describe('terminationVerdict (#323)', () => {
  it('retries the first termination of a render, wherever the app was', () => {
    expect(terminationVerdict('active', null)).toBe('retry');
    expect(terminationVerdict('background', null)).toBe('retry');
    expect(terminationVerdict('resuming', null)).toBe('retry');
  });

  it('pauses the page only when its retry also killed the process with the app in front', () => {
    expect(terminationVerdict('active', 'active')).toBe('page-failure');
    expect(terminationVerdict('active', 'background')).toBe('page-failure');
  });

  it('never blames the page for a repeat in the background or right after a resume', () => {
    expect(terminationVerdict('background', 'active')).toBe('not-started');
    expect(terminationVerdict('resuming', 'background')).toBe('not-started');
  });
});

describe('terminationMessage', () => {
  it('carries both app phases for the field report', () => {
    expect(terminationMessage('background', 'active')).toBe(
      'PdfRasterizer: rendering process terminated twice (app background, then active)',
    );
  });
});
