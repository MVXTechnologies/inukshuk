package expo.modules.inukshukappupdate

import android.app.Activity
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Google Play In-App Updates, flexible flow only (2.7.0 update prompt):
 * `check` asks Play what it has, `startFlexible` shows Play's own consent
 * sheet and downloads in the background, `onState` reports the download, and
 * `completeUpdate` installs it (Play restarts the app). The JS side decides
 * when any of this may happen (`src/lib/playAppUpdate.ts`); nothing here runs
 * by itself, and nothing restarts the app unless `completeUpdate` is called.
 *
 * Every failure (no Play Store, a sideloaded install, no account) rejects;
 * the JS side then falls back to the Play listing or stays silent.
 */
class InukshukAppUpdateModule : Module() {
  private var cached: AppUpdateManager? = null
  private var listening = false

  private val listener = InstallStateUpdatedListener { state ->
    sendEvent(
      "onState",
      mapOf(
        "status" to state.installStatus(),
        "bytesDownloaded" to state.bytesDownloaded().toDouble(),
        "totalBytes" to state.totalBytesToDownload().toDouble(),
      ),
    )
  }

  private fun manager(): AppUpdateManager {
    cached?.let { return it }
    val context = appContext.reactContext ?: throw CodedException("No React context")
    return AppUpdateManagerFactory.create(context).also { cached = it }
  }

  override fun definition() = ModuleDefinition {
    Name("InukshukAppUpdate")

    Events("onState")

    OnStartObserving {
      if (!listening) {
        runCatching { manager().registerListener(listener) }.onSuccess { listening = true }
      }
    }

    OnStopObserving {
      if (listening) {
        cached?.unregisterListener(listener)
        listening = false
      }
    }

    OnDestroy {
      if (listening) cached?.unregisterListener(listener)
      listening = false
    }

    AsyncFunction("check") { promise: Promise ->
      try {
        manager().appUpdateInfo
          .addOnSuccessListener { info ->
            promise.resolve(
              mapOf(
                "availability" to info.updateAvailability(),
                "versionCode" to info.availableVersionCode(),
                "installStatus" to info.installStatus(),
                "flexibleAllowed" to info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE),
                "bytesDownloaded" to info.bytesDownloaded().toDouble(),
                "totalBytes" to info.totalBytesToDownload().toDouble(),
              ),
            )
          }
          .addOnFailureListener { e -> promise.reject(CodedException("Play update check failed", e)) }
      } catch (e: Exception) {
        promise.reject(CodedException("Play update check failed", e))
      }
    }

    // Resolves true when the person accepted Play's sheet (the download runs),
    // false when they declined it. Rejects when Play cannot run a flexible
    // update here (the JS side then opens the Play listing).
    AsyncFunction("startFlexible") { promise: Promise ->
      try {
        val m = manager()
        m.appUpdateInfo
          .addOnSuccessListener { info ->
            val activity = appContext.currentActivity
            if (
              info.updateAvailability() != UpdateAvailability.UPDATE_AVAILABLE ||
              !info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)
            ) {
              promise.reject(CodedException("No flexible update on offer"))
            } else if (activity == null) {
              promise.reject(CodedException("No activity"))
            } else {
              m.startUpdateFlow(info, activity, AppUpdateOptions.defaultOptions(AppUpdateType.FLEXIBLE))
                .addOnSuccessListener { code -> promise.resolve(code == Activity.RESULT_OK) }
                .addOnFailureListener { e -> promise.reject(CodedException("Play update flow failed", e)) }
            }
          }
          .addOnFailureListener { e -> promise.reject(CodedException("Play update check failed", e)) }
      } catch (e: Exception) {
        promise.reject(CodedException("Play update flow failed", e))
      }
    }

    AsyncFunction("completeUpdate") { promise: Promise ->
      try {
        manager().completeUpdate()
          .addOnSuccessListener { promise.resolve(null) }
          .addOnFailureListener { e -> promise.reject(CodedException("Play install failed", e)) }
      } catch (e: Exception) {
        promise.reject(CodedException("Play install failed", e))
      }
    }
  }
}
