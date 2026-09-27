// Flat ESLint config (ESLint 9+). Extends Expo's recommended rules and turns
// off any rules that would fight Prettier.
const expoConfig = require('eslint-config-expo/flat');
const eslintConfigPrettier = require('eslint-config-prettier');

/**
 * Files that still hold hex colour literals from before the revamp. Shrinks
 * PR by PR; never add to it (put the colour in src/ui/tokens.ts instead).
 */
const HEX_ALLOWLIST = [
  'src/features/common/components/ElevationProfile.tsx',
  'src/features/map/MapScreen.tsx',
  'src/features/map/RegionSelectOverlay.tsx',
  'src/features/map/Trail2DView.tsx',
  'src/features/map/Trail3DGLScreen.tsx',
  'src/features/map/TrailViewerRail.tsx',
  'src/features/map/components/DestinationMarkerPin.tsx',
  'src/features/map/components/HeatPointCarousel.tsx',
  'src/features/map/components/InukshukIcon.tsx',
  'src/features/map/components/MapOverlaysMenu.tsx',
  'src/features/map/components/MapPointChip.tsx',
  'src/features/map/components/NoteNumberBadge.tsx',
  'src/features/map/components/RangeSlider.tsx',
  'src/features/map/components/RecordControls.tsx',
  'src/features/map/components/WaypointMarkerPin.tsx',
  'src/features/map/mapLayers.tsx',
  'src/features/map/mapStyle.ts',
  'src/features/map/mapmaker/MakeMapSheet.tsx',
  'src/features/map/marine/MarineLegend.tsx',
  'src/features/map/weather/WeatherCompareScreen.tsx',
  'src/features/map/weather/weatherChrome.ts',
  'src/features/store/LocatorThumb.tsx',
];

module.exports = [
  ...expoConfig,
  eslintConfigPrettier,
  {
    // Mechanical guard for AGENTS.md's #1 convention: src/core stays pure.
    // Without this, a stray platform import would pass typecheck, lint AND
    // jest (jest-expo resolves expo modules) and only surface in review.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-*',
                'expo',
                'expo-*',
                '@expo/*',
                '@react-native*',
                '@data/*',
                '@state/*',
                '@features/*',
                '@ui/*',
                '@lib/*',
              ],
              message:
                'src/core must stay pure (no React Native / Expo / upper-layer imports) — see AGENTS.md.',
            },
          ],
        },
      ],
    },
  },
  {
    // Revamp guard (docs/design/ui-revamp §1): colours come from the Stone &
    // Paper tokens (src/ui/tokens.ts), not hex literals scattered through
    // screens. src/core keeps its data palettes (weather/depth ramps,
    // categories, trail PDF) because core may not import @ui. Files that
    // still hold literals are listed in HEX_ALLOWLIST below; each revamp PR
    // that touches one moves its colours to tokens and drops it from the list.
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    ignores: ['src/ui/**', 'src/core/**', '**/*.test.{ts,tsx}', ...HEX_ALLOWLIST],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message: 'Use a colour token from @ui/tokens instead of a hex literal.',
        },
      ],
    },
  },
  {
    // Repo tooling runs in Node, not React Native: give it Node's globals so
    // Buffer/process/console are not flagged as undefined.
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    ignores: [
      'dist/*',
      'node_modules/*',
      // The two above are root-anchored, so they miss NESTED build output and
      // dependency trees — e.g. a sibling npm project's `web/dist` left in the
      // working tree lints its minified bundle and buries the real findings
      // under thousands of warnings. Never lint generated or vendored code,
      // at any depth.
      '**/dist/**',
      '**/node_modules/**',
      '.expo/*',
      'assets/pdfjs/*',
      'coverage/*',
      'android/*',
      'ios/*',
      // Agent tooling can leave whole checkouts under .claude/worktrees —
      // their copied sources must not be linted as part of this repo.
      '.claude/*',
      // The web playground is its own npm project with its own toolchain
      // (Vite, react-dom, maplibre-gl) and its own lint/typecheck scripts.
      // It reuses src/core by alias but must not be linted with the app's
      // React Native config, which knows nothing about the DOM.
      'web/*',
    ],
  },
];
