import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Inukshuk — offline georeferenced-PDF trail navigation.
 *
 * Dynamic config so we can wire EAS project id / OTA channels from the
 * environment in CI without committing secrets. See docs/ARCHITECTURE.md.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Inukshuk',
  slug: 'inukshuk',
  owner: 'pythagorasv02',
  // Bumped to 1.0.1 for the offline-maps release: it adds a native module, and
  // runtimeVersion follows appVersion — a new version name gives this build its
  // own OTA runtime, so it never pulls the older 1.0.0 runtime's JS (which lacks
  // the native module). Existing 1.0.0 installs keep their own OTA lineage.
  version: '1.0.1',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'inukshuk',
  userInterfaceStyle: 'automatic',
  // New Architecture is the default in SDK 56; splash is configured via the
  // expo-splash-screen plugin below (top-level `splash` was removed in SDK 56).
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.inukshuk.app',
    infoPlist: {
      // v1 records in the foreground only (screen kept awake), so no background
      // location mode is declared — keeps store review simple.
      ITSAppUsesNonExemptEncryption: false,
      // Allow cleartext to loopback only, for the in-app HTTP server that serves the
      // MapLibre style during an offline-region download (see src/data/offline.ts).
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
      // Let Inukshuk appear in iOS "Open in…" for .gpx files (declared now so iOS
      // is ready; iOS isn't being built yet).
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'GPS Exchange Format',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['com.topografix.gpx'],
        },
      ],
      UTImportedTypeDeclarations: [
        {
          UTTypeIdentifier: 'com.topografix.gpx',
          UTTypeConformsTo: ['public.xml'],
          UTTypeDescription: 'GPS Exchange Format',
          UTTypeTagSpecification: { 'public.filename-extension': ['gpx'] },
        },
      ],
    },
  },
  android: {
    package: 'com.inukshuk.app',
    // versionCode must keep monotonically increasing on Play (it can't reset) —
    // bump this each store build. (vc42 was 1.0.0; vc43 is 1.0.1, see version above.)
    versionCode: 43,
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      // Cream paper from the logo; the full-bleed foreground covers it, this only
      // shows at the mask edges during launcher parallax.
      backgroundColor: '#E0D8CC',
    },
    // While-in-use location plus a recording foreground service (the
    // expo-location plugin below adds FOREGROUND_SERVICE /
    // FOREGROUND_SERVICE_LOCATION). Deliberately NO ACCESS_BACKGROUND_LOCATION:
    // a foreground service keeps fixes flowing with the screen off using only
    // while-in-use permission, which avoids Play's stricter background-location
    // review.
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION'],
    // Let users open a .gpx with Inukshuk from a file manager / browser. File
    // managers are inconsistent about GPX's MIME type, so match by MIME AND by
    // a `.*\\.gpx` path pattern for both content:// and file:// URIs.
    intentFilters: [
      {
        action: 'VIEW',
        category: ['DEFAULT', 'BROWSABLE'],
        data: [
          { scheme: 'content', mimeType: 'application/gpx+xml' },
          { scheme: 'content', mimeType: 'application/xml' },
          { scheme: 'content', mimeType: 'application/octet-stream' },
          { scheme: 'content', pathPattern: '.*\\.gpx' },
          { scheme: 'file', pathPattern: '.*\\.gpx' },
        ],
      },
    ],
  },
  web: {
    favicon: './assets/favicon.png',
    bundler: 'metro',
  },
  plugins: [
    'expo-router',
    'expo-font',
    'expo-sharing',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        // Warm paper cream from the logo, matching the in-app background for a
        // seamless hand-off from splash to first screen.
        backgroundColor: '#F2ECE0',
        imageWidth: 200,
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Inukshuk uses your location to show where you are on the map and to record your trail.',
        isAndroidBackgroundLocationEnabled: false,
        // Adds FOREGROUND_SERVICE + FOREGROUND_SERVICE_LOCATION so recording
        // survives the screen turning off / app-switching, via
        // startLocationUpdatesAsync's foreground service (persistent
        // notification). Takes effect in the NEXT store binary; on older
        // binaries the JS falls back to the foreground-only watch at runtime.
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      '@maplibre/maplibre-react-native',
      {
        // We render OpenStreetMap raster tiles, so no proprietary SDK token.
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Inukshuk lets you attach photos from your library to trail notes.',
        cameraPermission: 'Inukshuk uses the camera to attach photos to trail notes.',
      },
    ],
    // Raise Gradle heap/metaspace so :expo-updates:kspReleaseKotlin doesn't OOM
    // on production builds (the SDK template's 512m metaspace is too small).
    './plugins/withGradleMemory',
    // Allow cleartext to loopback only, for the in-app HTTP server that serves the
    // MapLibre style during an offline-region download (see src/data/offline.ts).
    './plugins/withLocalhostCleartext',
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    eas: {
      projectId: process.env.EAS_PROJECT_ID ?? 'ba200eac-11b2-4c40-bd17-c0c66351ea54',
    },
    // Automatic error reporting (src/lib/errorReporting): a fine-grained GitHub
    // PAT with Issues-only read/write on marcandrevigneault/inukshuk, set as an
    // EAS secret (`eas env:create --name ERROR_REPORT_TOKEN ...`). Baked into
    // the binary at build time — the narrow scope is the mitigation. When unset
    // (local dev, forks), the app falls back to asking the user to open a
    // pre-filled GitHub issue instead.
    errorReportToken: process.env.ERROR_REPORT_TOKEN,
  },
  updates: {
    // OTA self-correction channel; CI (ota-update.yml) publishes JS-only fixes
    // to the `production` branch. URL is the EAS Update endpoint for this project
    // (https://u.expo.dev/<projectId>); env override allows pointing elsewhere.
    url: process.env.EAS_UPDATE_URL ?? 'https://u.expo.dev/ba200eac-11b2-4c40-bd17-c0c66351ea54',
    fallbackToCacheTimeout: 0,
  },
  runtimeVersion: {
    policy: 'appVersion',
  },
});
