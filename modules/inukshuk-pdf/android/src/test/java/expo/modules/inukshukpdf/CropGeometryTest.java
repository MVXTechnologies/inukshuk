package expo.modules.inukshukpdf;

/** Host-JVM regression checks; no Android runtime or test dependency required. */
public final class CropGeometryTest {
  private static int checks;
  private static void equal(double actual, double expected) {
    checks++;
    if (Math.abs(actual - expected) > 1e-9) throw new AssertionError(actual + " != " + expected);
  }
  private static void rejects(Runnable action) {
    checks++;
    try { action.run(); } catch (IllegalArgumentException expected) { return; }
    throw new AssertionError("Expected invalid geometry to be rejected");
  }
  private static void withinBudget(CropGeometry crop) {
    checks++;
    if (crop.widthPx > 3072 || crop.heightPx > 3072 ||
        (long)crop.widthPx * crop.heightPx > 3L * 1024 * 1024) {
      throw new AssertionError("Crop exceeds edge or pixel budget");
    }
  }
  public static void main(String[] args) {
    CropGeometry eco = CropGeometry.create(3456, 3024, .5625, .1875, .8125, .4375, 1896);
    equal(eco.widthPx, 1896); equal(eco.heightPx, 1659);
    equal(eco.scale, 1896d / 864d);
    equal(eco.offsetX, -4266); equal(eco.offsetY, -1244.25);
    CropGeometry square = CropGeometry.create(4000, 4000, 0, 0, 1, 1, 10000);
    withinBudget(square);
    equal(square.widthPx, 1773); equal(square.heightPx, 1773);
    CropGeometry tall = CropGeometry.create(100, 10240, 0, 0, 1, 1, 10000);
    equal(tall.widthPx, 30); equal(tall.heightPx, 3072);
    withinBudget(tall);
    CropGeometry wide = CropGeometry.create(10240, 100, 0, 0, 1, 1, 10000);
    equal(wide.widthPx, 3072); equal(wide.heightPx, 30);
    withinBudget(wide);
    // A portrait viewport uses the available pixel budget instead of being
    // prematurely downscaled to the old 2048-pixel height cap.
    CropGeometry portrait = CropGeometry.create(1320, 2600, 0, 0, 1, 1, 1320);
    equal(portrait.widthPx, 1263); equal(portrait.heightPx, 2489);
    withinBudget(portrait);
    CropGeometry fractional = CropGeometry.create(3370.39, 2383.94, .1, .2, .4, .5, 1000);
    equal(fractional.scale, 1000 / (3370.39 * (.4 - .1)));
    equal(fractional.offsetX, -.1 * 3370.39 * fractional.scale);
    CropGeometry.requirePageSize(3370, 2383, 3370.39, 2383.94);
    rejects(() -> CropGeometry.requirePageSize(2383, 3370, 3370.39, 2383.94));
    rejects(() -> CropGeometry.requirePageSize(3371, 2383, 3370, 2383.94));
    for (double invalid : new double[]{Double.NaN, Double.POSITIVE_INFINITY, 0, -1}) {
      rejects(() -> CropGeometry.create(invalid, 100, 0, 0, 1, 1, 100));
      rejects(() -> CropGeometry.create(100, invalid, 0, 0, 1, 1, 100));
      rejects(() -> CropGeometry.create(100, 100, 0, 0, 1, 1, invalid));
    }
    rejects(() -> CropGeometry.create(100, 100, -.01, 0, 1, 1, 100));
    rejects(() -> CropGeometry.create(100, 100, 0, 0, 1.01, 1, 100));
    rejects(() -> CropGeometry.create(100, 100, .5, .5, .5, 1, 100));
    rejects(() -> CropGeometry.create(100, 100, 0, .5, 1, .4, 100));
    rejects(() -> CropGeometry.create(100, 100, 0, 0, Double.NaN, 1, 100));
    rejects(() -> CropGeometry.create(Double.MAX_VALUE, Double.MAX_VALUE, 0, 0, 1, 1, 100));
    System.out.println("Crop geometry checks passed: " + checks);
  }
}
