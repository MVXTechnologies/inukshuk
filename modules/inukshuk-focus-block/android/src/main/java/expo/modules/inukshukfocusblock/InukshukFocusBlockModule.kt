package expo.modules.inukshukfocusblock

import android.content.Context
import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView

/**
 * A container whose subtree can never take focus (#715). The app keeps
 * hidden 1 dp WebViews mounted (PDF rasterizer, photo resizer). When a
 * focused text field leaves the screen, Android hands focus to the first
 * view focusable in touch mode — one of those WebViews (a WebView is) — and
 * the soft keyboard stays up for it, over the next screen. Wrapped in this
 * view, they are skipped: the block is on the container
 * (FOCUS_BLOCK_DESCENDANTS) and on each view added under it.
 */
class InukshukFocusBlockModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("InukshukFocusBlock")
    View(FocusBlockView::class) {}
  }
}

class FocusBlockView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  init {
    descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
    isFocusable = false
    isFocusableInTouchMode = false
  }

  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    unfocusable(child)
  }

  private fun unfocusable(view: View) {
    view.isFocusable = false
    view.isFocusableInTouchMode = false
    if (view is ViewGroup) {
      view.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
      for (i in 0 until view.childCount) unfocusable(view.getChildAt(i))
    }
  }
}
