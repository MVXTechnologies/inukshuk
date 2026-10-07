import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Both after-save prompts subscribe to the recorder's `lastSavedTrackId`, and
 * the Strava one consumes it (sets it back to null) synchronously inside its
 * zustand listener. A listener registered AFTER it is handed the already
 * cleared state and never fires — the "Add photos from this outing?" prompt
 * silently never showed on the device (#587 QA). Mount order decides
 * subscription order, so the photo prompt must come first in the root layout.
 */
it('mounts the photo prompt before the Strava push prompt', () => {
  const layout = readFileSync(join(__dirname, '..', '..', '..', 'app', '_layout.tsx'), 'utf8');
  const photo = layout.indexOf('<AddPhotosAfterSavePrompt />');
  const strava = layout.indexOf('<StravaPushPrompt />');
  expect(photo).toBeGreaterThan(0);
  expect(strava).toBeGreaterThan(0);
  expect(photo).toBeLessThan(strava);
});
