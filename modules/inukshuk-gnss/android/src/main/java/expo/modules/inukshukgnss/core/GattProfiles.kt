package expo.modules.inukshukgnss.core

// Pure (no android.*): compiled on a plain JVM by android/tests/run.sh.

/**
 * A serial-over-BLE profile: one GATT service, the characteristic the
 * receiver NOTIFIES its output on, and (optionally) the one we WRITE to.
 *
 * Profiles are data, sent from JS on every scan/connect
 * (src/lib/gnss/bleProfiles.ts holds the defaults: Nordic UART, Microchip
 * transparent UART, HM-10 FFE0). Native code keeps no list of its own, so a
 * new receiver family is a JS-only (OTA-able) change.
 *
 * UUIDs are stored normalised (see [normalizeUuid]).
 */
data class GattProfile(
  val name: String,
  val service: String,
  val notify: String,
  val write: String?,
)

private const val BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb"
private val HEX = Regex("^[0-9a-f]+$")
private val FULL = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

/**
 * Lower-case 128-bit form. 16- and 32-bit short forms ("ffe0", "0000ffe0")
 * expand on the Bluetooth base UUID, the way CoreBluetooth and Android print
 * them. Returns null for anything that is not a UUID.
 */
fun normalizeUuid(raw: String): String? {
  val s = raw.trim().lowercase()
  return when {
    FULL.matches(s) -> s
    s.length == 4 && HEX.matches(s) -> "0000$s$BASE_SUFFIX"
    s.length == 8 && HEX.matches(s) -> "$s$BASE_SUFFIX"
    else -> null
  }
}

/** Builds a profile, or null when a UUID is malformed or the name empty. */
fun gattProfileOf(name: String, service: String, notify: String, write: String?): GattProfile? {
  val s = normalizeUuid(service) ?: return null
  val n = normalizeUuid(notify) ?: return null
  val w = if (write.isNullOrBlank()) null else (normalizeUuid(write) ?: return null)
  if (name.isBlank()) return null
  return GattProfile(name, s, n, w)
}

/**
 * What service discovery found on the peripheral: service UUID → its
 * characteristics' UUIDs → whether that characteristic can notify/indicate.
 */
typealias DiscoveredGatt = Map<String, Map<String, CharCaps>>

data class CharCaps(val canNotify: Boolean, val canWrite: Boolean)

/** The profile to use, and whether its write characteristic is usable. */
data class ProfileChoice(val profile: GattProfile, val writable: Boolean)

/**
 * First profile (in the caller's priority order) whose service exists, whose
 * output characteristic can notify, and whose write characteristic can be
 * written. A profile naming the SAME UUID for both (HM-10's FFE1) needs one
 * characteristic with both capabilities.
 *
 * When no profile matches fully, the first one that can at least stream is
 * returned with `writable = false`: positions still flow, and only writes
 * (UBX configuration, RTCM corrections) are refused.
 */
fun selectProfile(profiles: List<GattProfile>, found: DiscoveredGatt): ProfileChoice? {
  fun streams(p: GattProfile) = found[p.service]?.get(p.notify)?.canNotify == true
  fun writes(p: GattProfile) = p.write != null && found[p.service]?.get(p.write)?.canWrite == true
  profiles.firstOrNull { streams(it) && writes(it) }?.let { return ProfileChoice(it, true) }
  profiles.firstOrNull { streams(it) }?.let { return ProfileChoice(it, false) }
  return null
}
