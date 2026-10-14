# MapEglGuard swaps this field by name (see README.md): keep it under R8.
-keepclassmembers class org.maplibre.android.maps.renderer.surfaceview.MapLibreGLSurfaceView {
    android.opengl.GLSurfaceView$EGLWindowSurfaceFactory eglWindowSurfaceFactory;
}
