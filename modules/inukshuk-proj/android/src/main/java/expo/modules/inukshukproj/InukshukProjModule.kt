package expo.modules.inukshukproj

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal object ProjNative {
  init {
    System.loadLibrary("inukshukproj")
  }

  @JvmStatic external fun init(db: String, dirs: Array<String>): String
  @JvmStatic external fun transform(pipeline: String, coords: DoubleArray, dim: Int): String
  @JvmStatic external fun transformCrs(src: String, dst: String, coords: DoubleArray, dim: Int): String
  @JvmStatic external fun epsgOperation(code: String): String
}

private fun JSONObject.toMap(): Map<String, Any?> =
  keys().asSequence().associateWith { k ->
    when (val v = get(k)) {
      is JSONObject -> v.toMap()
      is JSONArray -> (0 until v.length()).map { i -> (v.get(i) as? JSONObject)?.toMap() ?: v.get(i) }
      JSONObject.NULL -> null
      else -> v
    }
  }

/**
 * The Convert tool's PROJ engine. proj.db and the two bundled grids ship as
 * APK assets (assets/inukshukproj/) and are copied to the files dir once per
 * app install/update: SQLite and libtiff need real files.
 */
class InukshukProjModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no React context")

  /** Copies the bundled data out of the APK when missing or from an older install. */
  private fun ensureData(): File {
    val root = File(context.filesDir, "inukshukproj")
    val stamp = File(root, ".installed")
    val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
    val want = "${pkg.lastUpdateTime}"
    if (stamp.exists() && stamp.readText() == want && File(root, "proj.db").exists()) return root
    root.mkdirs()
    File(root, "grids").mkdirs()
    val assets = context.assets
    val files = listOf("proj.db") + (assets.list("inukshukproj/grids") ?: emptyArray()).map { "grids/$it" }
    for (name in files) {
      val dst = File(root, name)
      val tmp = File(root, "$name.part")
      assets.open("inukshukproj/$name").use { input -> tmp.outputStream().use { input.copyTo(it) } }
      if (!tmp.renameTo(dst)) {
        dst.delete()
        tmp.renameTo(dst)
      }
    }
    stamp.writeText(want)
    return root
  }

  override fun definition() = ModuleDefinition {
    Name("InukshukProj")

    Constant("supported") { true }

    Function("init") { gridDirs: List<String> ->
      val root = ensureData()
      val dirs = arrayOf(File(root, "grids").absolutePath) + gridDirs.toTypedArray()
      val out = JSONObject(ProjNative.init(File(root, "proj.db").absolutePath, dirs)).toMap().toMutableMap()
      out["bundledGridDir"] = File(root, "grids").absolutePath
      out
    }

    Function("transform") { pipeline: String, coords: List<Double>, dim: Int ->
      JSONObject(ProjNative.transform(pipeline, coords.toDoubleArray(), dim)).toMap()
    }

    Function("transformCrs") { src: String, dst: String, coords: List<Double>, dim: Int ->
      JSONObject(ProjNative.transformCrs(src, dst, coords.toDoubleArray(), dim)).toMap()
    }

    Function("epsgOperation") { code: String ->
      JSONObject(ProjNative.epsgOperation(code)).toMap()
    }
  }
}
