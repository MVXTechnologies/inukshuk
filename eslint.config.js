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
    ignores: [
      'dist/*',
      'node_modules/*',
      '.expo/*',
      'assets/pdfjs/*',
      'coverage/*',
      'android/*',
      'ios/*',
    ],
  },
];
