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
  // 2.0.0: the vector Stone & Paper base map on our own Protomaps tiles
  // (Cloudflare; infra/tiles), served contour lines, vector offline packs,
  // and the rest of the UI revamp (display modes, Library, Maps, Logbook).
  // 1.7.0 was the first half of the revamp (Atkinson embedded natively).
  version: '2.0.0',
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
    // Increase for every App Store Connect upload.
    buildNumber: '11',
    infoPlist: {
      // Trail recording keeps running with the screen off / app backgrounded.
      // The expo-location plugin (isIosBackgroundLocationEnabled) also adds
      // this; declared explicitly so the requirement is visible here.
      UIBackgroundModes: ['location'],
      ITSAppUsesNonExemptEncryption: false,
      // ITMS-90737: apps declaring CFBundleDocumentTypes must state whether
      // they open documents in place. Inukshuk IMPORTS (copies) GPX into its
      // own storage — it never edits the source file — so false is correct.
      LSSupportsOpeningDocumentsInPlace: false,
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
    // Play build 57 ships 2.0.0 (see the version note above).
    versionCode: 57,
    // Brand icon split into layers (scripts/brand/build-icons.py): the landscape
    // is the background, the stone figure + contact shadow the foreground (inside
    // the 66 dp safe zone), and a one-colour silhouette for Android 13+ themed
    // icons. backgroundColor is only a fallback — backgroundImage overrides it.
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
      backgroundColor: '#E0D8CC',
    },
    // While-in-use location, a recording foreground service (the expo-location
    // plugin below adds FOREGROUND_SERVICE / FOREGROUND_SERVICE_LOCATION), and
    // background location. The foreground service alone keeps fixes flowing
    // with the screen off under while-in-use permission; "Allow all the time"
    // (requested in-app with a rationale, only when a recording starts) makes
    // tracking survive aggressive OEM battery management and process restarts.
    // Play's background-location review will require a declaration + demo video.
    //
    // RECEIVE_BOOT_COMPLETED is REQUIRED by expo-task-manager: it schedules its
    // location jobs with JobInfo.setPersisted(true), and Android throws (a
    // native, uncatchable process death inside TaskBroadcastReceiver) for any
    // backgrounded fix delivery if the permission is missing. Its absence in
    // vc44 (1.0.2) crash-looped the app the moment a recording backgrounded —
    // do not remove it while the background task exists. Neither the
    // expo-location nor expo-task-manager config plugin adds it for us.
    // POST_NOTIFICATIONS (Android 13+): without it the recording foreground
    // service still runs but its "Inukshuk is recording your track"
    // notification is silently suppressed — users get no indication a
    // recording is live, and Play's background-location policy expects a
    // visible notification. Requested at record start (useBackgroundRecording).
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'RECEIVE_BOOT_COMPLETED',
      'POST_NOTIFICATIONS',
      // Health Connect import (#435), read-only: exercise sessions, their GPS
      // routes (READ_EXERCISE_ROUTES = "all routes"; without it each route
      // from another app asks per session), distance totals, and history
      // older than 30 days. Play requires a Health apps declaration for these.
      'android.permission.health.READ_EXERCISE',
      'android.permission.health.READ_EXERCISE_ROUTES',
      'android.permission.health.READ_DISTANCE',
      'android.permission.health.READ_HEALTH_DATA_HISTORY',
    ],
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
    // Android: the system navigation bar starts hidden (swipe up to reveal);
    // src/ui/useAndroidImmersive keeps it that way.
    ['expo-navigation-bar', { hidden: true }],
    // Atkinson Hyperlegible Next, embedded natively so text is in the brand
    // face from the first frame (no load gate). Families and weights are
    // mirrored in src/ui/fonts.ts. Embedding changes the native fingerprint:
    // since 1.7.0, OTA updates from main target the current store runtime only.
    [
      'expo-font',
      {
        ios: {
          fonts: [
            './assets/fonts/AtkinsonHyperlegibleNext_400Regular.ttf',
            './assets/fonts/AtkinsonHyperlegibleNext_500Medium.ttf',
            './assets/fonts/AtkinsonHyperlegibleNext_700Bold.ttf',
            './assets/fonts/AtkinsonHyperlegibleNext_800ExtraBold.ttf',
          ],
        },
        android: {
          fonts: [
            {
              fontFamily: 'AtkinsonHyperlegibleNext',
              fontDefinitions: [
                { path: './assets/fonts/AtkinsonHyperlegibleNext_400Regular.ttf', weight: 400 },
                { path: './assets/fonts/AtkinsonHyperlegibleNext_500Medium.ttf', weight: 500 },
                { path: './assets/fonts/AtkinsonHyperlegibleNext_700Bold.ttf', weight: 700 },
                {
                  path: './assets/fonts/AtkinsonHyperlegibleNext_800ExtraBold.ttf',
                  weight: 800,
                },
              ],
            },
          ],
        },
      },
    ],
    'expo-sharing',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        // Warm paper cream from the logo, matching the in-app background for a
        // seamless hand-off from splash to first screen.
        backgroundColor: '#F2ECE0',
        imageWidth: 200,
        // Dark appearance: stone-night background, and the figure in its night
        // tone (the charcoal stones vanish on a dark background otherwise).
        dark: {
          image: './assets/splash-icon-dark.png',
          backgroundColor: '#13171B',
        },
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'Inukshuk uses your location to show where you are on the map and to record your trail.',
        locationAlwaysAndWhenInUsePermission:
          'Inukshuk uses your location in the background to keep recording your trail while the screen is off or you use another app.',
        locationAlwaysPermission:
          'Inukshuk uses your location in the background to keep recording your trail while the screen is off or you use another app.',
        // ACCESS_BACKGROUND_LOCATION ("Allow all the time"): keeps the recording
        // task alive across process restarts and strict OEM battery managers.
        isAndroidBackgroundLocationEnabled: true,
        // Adds FOREGROUND_SERVICE + FOREGROUND_SERVICE_LOCATION so recording
        // survives the screen turning off / app-switching, via
        // startLocationUpdatesAsync's foreground service (persistent
        // notification).
        isAndroidForegroundServiceEnabled: true,
        // Adds UIBackgroundModes: [location] on iOS.
        isIosBackgroundLocationEnabled: true,
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
    // Apple Health import (#435): the HealthKit entitlement + read usage text.
    // Read-only — no update description, no background delivery.
    [
      '@kingstinct/react-native-healthkit',
      {
        NSHealthShareUsageDescription:
          'Inukshuk reads your workouts and their routes so you can see them on your maps. It never writes to Health.',
        NSHealthUpdateUsageDescription: false,
        background: false,
      },
    ],
    // Health Connect import (#435): the permissions-rationale intent filter and
    // the Android 14+ VIEW_PERMISSION_USAGE activity-alias. The permissions
    // themselves are listed under android.permissions above.
    'react-native-health-connect',
    // Health Connect's client library needs minSdk 26 (was React Native's 24).
    ['expo-build-properties', { android: { minSdkVersion: 26 } }],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    eas: {
      projectId: process.env.EAS_PROJECT_ID ?? 'ba200eac-11b2-4c40-bd17-c0c66351ea54',
    },
    // Automatic error reporting (src/lib/errorReporting). Reports are always
    // filed silently in the background — the app never asks the user to open
    // GitHub. Two mutually exclusive channels (endpoint wins if both are set):
    //
    //  - ERROR_REPORT_TOKEN: a fine-grained GitHub PAT with Issues-only
    //    read/write on marcandrevigneault/inukshuk, set as an EAS secret
    //    (`eas env:create --name ERROR_REPORT_TOKEN ...`). It is baked into the
    //    binary at build time — the narrow scope is the mitigation.
    //  - ERROR_REPORT_ENDPOINT: URL of a relay that holds the token
    //    server-side, so nothing secret ships in the binary.
    //
    // With neither set (local dev, forks), reports just stay queued on disk.
    // See docs/DEPLOYMENT.md § Error reporting.
    errorReportToken: process.env.ERROR_REPORT_TOKEN,
    errorReportEndpoint: process.env.ERROR_REPORT_ENDPOINT,
    // Strava integration (src/lib/strava): only the PUBLIC client id ships.
    // Strava has no PKCE, so the code exchange and refreshes go through our
    // token proxy (infra/tiles/worker), which holds the client secret — the
    // June-2026 API agreement forbids baking it into a binary. Unset (local
    // dev, forks): the Settings row shows "not configured in this build".
    // See docs/DEPLOYMENT.md § Strava.
    stravaClientId: process.env.STRAVA_CLIENT_ID,
    // Map-store catalog manifest (src/data/catalogCache). Unset = the Pages
    // site (/catalog/v1/manifest.json). E2E builds point it at a loopback
    // fixture server (see .maestro/store.yaml) so CI never depends on NRCan.
    catalogManifestUrl: process.env.CATALOG_MANIFEST_URL,
    // Vector base-map tiles and label glyphs (src/data/basemapTiles). Unset =
    // our Cloudflare Worker; dev points them at a local `wrangler dev`, and
    // VECTOR_GLYPHS_URL=none falls back to OpenFreeMap's Noto.
    vectorTilesUrl: process.env.VECTOR_TILES_URL,
    vectorGlyphsUrl: process.env.VECTOR_GLYPHS_URL,
    vectorContoursUrl: process.env.VECTOR_CONTOURS_URL,
  },
  updates: {
    // OTA self-correction channel; CI (ota-update.yml) publishes JS-only fixes
    // to the `production` branch. URL is the EAS Update endpoint for this project
    // (https://u.expo.dev/<projectId>); env override allows pointing elsewhere.
    url: process.env.EAS_UPDATE_URL ?? 'https://u.expo.dev/ba200eac-11b2-4c40-bd17-c0c66351ea54',
    fallbackToCacheTimeout: 0,
  },
  // The runtime an OTA update targets is a fingerprint: a hash of everything
  // native in the project — native dependencies and their versions, config
  // plugins, modules/, the native half of this config (fingerprint.config.js
  // lists what is deliberately left out). It changes exactly when a new binary
  // is needed, without anyone having to remember to bump it.
  //
  // It replaces `appVersion`, which only moved when a human bumped `version`.
  // Dependabot auto-merged native-bearing bumps mid-runtime —
  // @maplibre/maplibre-react-native 11.3.6 → 11.3.7 (28498e3) and → 11.3.8
  // (7ffb3cc), @dr.pogodin/react-native-fs twice — and each lockfile change
  // was published OTA to 1.5.0 binaries built with the older native code.
  // Nothing crashed, by luck: a changed native module contract fails at call
  // time, not at launch. Under a fingerprint the same merge gets a runtime no
  // installed binary has, so the update reaches nobody until a store build
  // ships with it.
  runtimeVersion: {
    policy: 'fingerprint',
  },
});
