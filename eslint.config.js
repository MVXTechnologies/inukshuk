// Flat ESLint config (ESLint 9+). Extends Expo's recommended rules and turns
// off any rules that would fight Prettier.
const expoConfig = require('eslint-config-expo/flat');
const eslintConfigPrettier = require('eslint-config-prettier');

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
