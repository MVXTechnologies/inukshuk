# Inukshuk team mesh transport

Local Expo module (`InukshukMesh`, Android + iOS) for serverless team mode (#589): DNS-SD discovery and length-prefixed TCP frames between phones on the same Wi-Fi or hotspot. It moves opaque frames only; crypto and sync live in `src/core/team`.

Design, wire format, limits, background behaviour, permissions: [docs/design/team-mesh.md](../../docs/design/team-mesh.md). JS entry point: `src/data/team`.

Host tests: `sh scripts/test-android.sh` (kotlinc + JDK 17) and `sh ios/Tests/run.sh` (macOS).
