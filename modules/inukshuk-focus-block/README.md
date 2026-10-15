# inukshuk-focus-block (Android)

`FocusBlockView`: a container whose subtree can never take focus (#715).
Wraps the app's always-mounted hidden WebViews (PDF rasterizer, photo
resizer) so Android cannot hand them focus when a focused text field leaves
the screen, which left the soft keyboard up over the next screen. JS:
`src/ui/FocusBlock.tsx` (a plain View on iOS, and where the native view is
absent).
