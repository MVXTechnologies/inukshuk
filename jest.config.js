/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Allow Jest to transpile the ESM-shipping RN / Expo / MapLibre packages.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@maplibre/.*|nanoid|proj4|fast-xml-parser))',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@data/(.*)$': '<rootDir>/src/data/$1',
    '^@features/(.*)$': '<rootDir>/src/features/$1',
    '^@ui/(.*)$': '<rootDir>/src/ui/$1',
    '^@state/(.*)$': '<rootDir>/src/state/$1',
    '^@lib/(.*)$': '<rootDir>/src/lib/$1',
  },
  collectCoverageFrom: [
    'src/core/**/*.{ts,tsx}',
    '!src/core/**/*.d.ts',
    // Pure re-export barrels — no logic to measure. Real modules that happen to
    // be named index.ts (gpx, track) stay covered; don't re-add a blanket glob.
    '!src/core/geo/geopdf/index.ts',
    '!src/core/models/index.ts',
    // Test-only fixture helpers.
    '!src/core/geo/geopdf/testUtils.ts',
  ],
  coverageThreshold: {
    // Pure logic in src/core is the safety-critical part — hold it to a high bar.
    './src/core/': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  clearMocks: true,
};
