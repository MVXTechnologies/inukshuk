package expo.modules.inukshukmapegl.core

/**
 * Whether the app runs on the Android emulator, from signals read once at
 * start-up (#697). The map EGL guard installs only there: the use-after-free
 * needs the emulator's goldfish EGL driver, which refuses MapLibre's
 * surfaceless unbind. Phone drivers accept it, so phones keep MapLibre's
 * behaviour untouched, with no reflection.
 *
 * Any one signal is enough: emulator images differ (goldfish vs ranchu
 * kernels, "generic" vs "google/sdk_gphone" fingerprints, ro.kernel.qemu
 * gone in recent images), but none of them shows up on a shipping phone.
 * Pure (no Android types): tested on a plain JVM.
 */
data class EmulatorSignals(
  /** ro.kernel.qemu or ro.boot.qemu; null when unset or unreadable. */
  val qemuProperty: String?,
  /** Build.HARDWARE (ro.hardware). */
  val hardware: String?,
  /** Build.FINGERPRINT. */
  val fingerprint: String?,
  /** Build.PRODUCT. */
  val product: String?,
  /** The emulator's EGL driver (libEGL_emulation.so) is installed. */
  val emulationEglDriver: Boolean,
)

private val EMULATOR_HARDWARE = setOf("goldfish", "ranchu")

/** The signals that matched, empty on a real device (logged for the record). */
fun emulatorEvidence(s: EmulatorSignals): List<String> {
  val found = ArrayList<String>()
  if (s.qemuProperty?.trim() == "1") found.add("qemu property")
  if (s.hardware?.trim()?.lowercase() in EMULATOR_HARDWARE) found.add("hardware ${s.hardware}")
  val fp = s.fingerprint?.trim().orEmpty()
  if (fp.startsWith("generic") || fp.contains("/sdk_gphone")) found.add("fingerprint")
  val product = s.product?.trim()?.lowercase().orEmpty()
  if (product.startsWith("sdk_gphone") || product.startsWith("sdk_google") ||
    product == "sdk" || product.startsWith("sdk_x86")
  ) {
    found.add("product $product")
  }
  if (s.emulationEglDriver) found.add("libEGL_emulation")
  return found
}

fun isEmulator(s: EmulatorSignals): Boolean = emulatorEvidence(s).isNotEmpty()
