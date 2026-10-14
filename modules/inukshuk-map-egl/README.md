# Inukshuk map EGL guard (Android emulator only)

Local Expo module, Android only and with no JS API. **On the Android emulator
only**, it keeps MapLibre's GL render thread from destroying an EGL window
surface that is still current (#697). On real devices it does nothing.

## The bug

MapLibre Android (13.6.1, `MapLibreGLSurfaceView.EglHelper`) unbinds a surface
before destroying it with `eglMakeCurrent(NO_SURFACE, NO_SURFACE, context)`, a
surfaceless bind, and ignores the result. A driver without
`EGL_KHR_surfaceless_context` refuses that bind with `EGL_BAD_MATCH`. The
Android emulator's goldfish EGL is one. The surface is then destroyed while
still current:

1. EGL defers the destroy.
2. libEGL disconnects the window at once, freeing the buffer the surface still
   holds. libgui logs `freeAllBuffers: 1 buffers were freed while being
dequeued!`.
3. The next `eglMakeCurrent` runs the deferred destroy, which cancels the freed
   buffer in `Surface::cancelBuffer`: a use-after-free.

This happens every time the map view is resized after its surface exists (at
start-up, or when the keyboard opens). GWP-ASan turns it into a SIGSEGV only
when it happened to sample that buffer.

## Why emulator only

The use-after-free needs a driver that refuses the surfaceless bind. The
emulator's goldfish EGL refuses it. Phone drivers accept it, and the surface is
then destroyed immediately, safely. The guard reaches a private MapLibre field
by reflection, and its fix has not been tested on phones. So it is not shipped
to users' devices for a bug they cannot hit.

At start-up, `MapEglPackage` reads `core/EmulatorDetection.kt`'s signals:
`Build.HARDWARE` (goldfish or ranchu), `Build.FINGERPRINT` (`generic…` or
`…/sdk_gphone…`), `Build.PRODUCT` (`sdk_gphone…`, `sdk_google…`) and whether
`libEGL_emulation.so` is installed. Any one of them means emulator.
`ro.kernel.qemu` is handled by the core too, but the app can't read it without
the hidden `SystemProperties` API. The other signals cover every current image.

On a real device the guard logs `map EGL guard: not an emulator, skipped`
once. It installs no listener and does no reflection. On an emulator it logs
`map EGL guard: emulator (<signals>), on`.

The teardown order is still wrong in principle: MapLibre should not destroy
a surface it failed to unbind. The upstream report stands, and it would fix
every driver without this module.

## The guard

`MapEglPackage` adds a global-layout listener to the activity's decor view.
`MapEglGuard` finds each `MapLibreGLSurfaceView` and replaces its private
`eglWindowSurfaceFactory` with `ReleasingWindowSurfaceFactory`, which wraps
MapLibre's own factory. If the surface is still current at destroy time, the
wrapper first releases the context completely (`NO_SURFACE, NO_SURFACE,
NO_CONTEXT`), which is AOSP `GLSurfaceView`'s own order.

Each avoided use-after-free logs `InukshukMapEgl: released a still-current map
surface`. If a MapLibre upgrade renames the field, the guard logs `map EGL guard
NOT installed`, and E2E fails on the use-after-free line (see
`.github/scripts/e2e-attempts.sh`, `launch_health`).

Remove the module once MapLibre falls back to `EGL_NO_CONTEXT` itself.

## Tests

`sh modules/inukshuk-map-egl/scripts/test-android.sh` runs the pure core
(`core/SurfaceTeardown.kt`: the teardown order and the view-tree walk;
`core/EmulatorDetection.kt`: emulator vs real device) on a
plain JVM. CI runs it in the Android native-build job.
