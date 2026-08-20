import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The playground is a separate npm project that reaches UP into the app's
 * `src/core` — the pure, platform-free logic layer (see AGENTS.md). Nothing is
 * copied: `@core/*` resolves to the real files, so a change in the app's
 * georeferencing/weather/catalog logic shows up here on the next HMR tick.
 *
 * `server.fs.allow` has to be widened for that: by default Vite refuses to
 * serve files outside the project root, and `../src/core` is outside `web/`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../src/core', import.meta.url)),
      // `@lib` reaches ONE file: `src/lib/format.ts`, the app's distance /
      // elevation / duration / pace / timestamp formatters. They are pure and
      // dependency-free, but they live outside `src/core`, so the Library's
      // number formatting is the one piece of shared logic that is not behind
      // the `@core` boundary. Reused rather than re-typed, because a card that
      // rounds differently from the app is a card you cannot judge. See the
      // README's "what leaked" note — this belongs in `@core/format`.
      '@lib': fileURLToPath(new URL('../src/lib', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // `src/core/geo/gpx` imports fast-xml-parser. Resolved from the importer it
    // would land in the ROOT node_modules; dedupe pins it to the copy this
    // project installed, so the playground runs without a root `npm install`.
    dedupe: ['fast-xml-parser', 'react', 'react-dom'],
  },
  server: {
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
});
