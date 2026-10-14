package expo.modules.inukshukmapegl.core

// Plain-JVM checks of the emulator detection (scripts/test-android.sh). The
// guard installs only where this says "emulator" (#697), so the phone cases
// matter as much as the emulator ones: a false positive would put the
// reflective swap on a user's phone.

private fun expect(label: String, ok: Boolean) {
  if (!ok) throw AssertionError(label)
  println("ok - $label")
}

private val PHONE =
  EmulatorSignals(
    qemuProperty = null,
    hardware = "oriole",
    fingerprint = "google/oriole/oriole:14/UQ1A.240205.004/11269751:user/release-keys",
    product = "oriole",
    emulationEglDriver = false,
  )

fun main() {
  // Real devices: no signal at all.
  expect("Pixel 6: not an emulator", !isEmulator(PHONE))
  expect(
    "Samsung (exynos): not an emulator",
    !isEmulator(
      PHONE.copy(
        hardware = "s5e9945",
        fingerprint = "samsung/e3qxxx/e3q:16/BP2A/S928BXXU:user/release-keys",
        product = "e3qxxx",
      ),
    ),
  )
  expect("qemu property 0: not an emulator", !isEmulator(PHONE.copy(qemuProperty = "0")))
  expect("unreadable signals: not an emulator", !isEmulator(EmulatorSignals(null, null, null, null, false)))
  expect("phone evidence is empty", emulatorEvidence(PHONE).isEmpty())

  // Each signal alone is enough.
  expect("ro.kernel.qemu=1", isEmulator(PHONE.copy(qemuProperty = "1")))
  expect("ranchu kernel", isEmulator(PHONE.copy(hardware = "ranchu")))
  expect("goldfish kernel", isEmulator(PHONE.copy(hardware = "goldfish")))
  expect("generic fingerprint", isEmulator(PHONE.copy(fingerprint = "generic/sdk/generic:7.0/x:userdebug/test-keys")))
  expect(
    "sdk_gphone fingerprint",
    isEmulator(PHONE.copy(fingerprint = "google/sdk_gphone64_x86_64/emu64xa:14/UE1A/1:userdebug/dev-keys")),
  )
  expect("sdk_gphone product", isEmulator(PHONE.copy(product = "sdk_gphone64_arm64")))
  expect("libEGL_emulation present", isEmulator(PHONE.copy(emulationEglDriver = true)))

  // The CI image (run 38521047124): every signal agrees.
  val ci =
    EmulatorSignals(
      qemuProperty = "1",
      hardware = "ranchu",
      fingerprint = "google/sdk_gphone64_x86_64/emu64xa:14/UE1A.230829.050/12077443:userdebug/dev-keys",
      product = "sdk_gphone64_x86_64",
      emulationEglDriver = true,
    )
  expect("CI emulator: all five signals", emulatorEvidence(ci).size == 5)
}
