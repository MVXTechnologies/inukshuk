package expo.modules.inukshukpdf;

/** Matches core rasterCropGeometry for a verified unrotated PDF detail crop. */
public final class CropGeometry {
  public final int widthPx, heightPx;
  public final double scale, offsetX, offsetY;

  private CropGeometry(int widthPx, int heightPx, double scale, double offsetX, double offsetY) {
    this.widthPx = widthPx;
    this.heightPx = heightPx;
    this.scale = scale;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
  }

  public static CropGeometry create(double pageWidth, double pageHeight,
      double x0, double y0, double x1, double y1, double targetWidth) {
    for (double value : new double[]{pageWidth, pageHeight, x0, y0, x1, y1, targetWidth}) {
      if (!Double.isFinite(value)) throw new IllegalArgumentException("Non-finite PDF crop geometry");
    }
    if (pageWidth <= 0 || pageHeight <= 0 || targetWidth <= 0 ||
        x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1 || x1 <= x0 || y1 <= y0) {
      throw new IllegalArgumentException("Invalid PDF crop geometry");
    }
    double width = pageWidth * (x1 - x0), height = pageHeight * (y1 - y0);
    double area = width * height;
    if (!Double.isFinite(area) || area <= 0) throw new IllegalArgumentException("Invalid PDF crop area");
    double scale = Math.min(Math.min(targetWidth / width, 3072d / width),
        Math.min(3072d / height, Math.sqrt((3d * 1024 * 1024) / area)));
    double offsetX = -x0 * pageWidth * scale, offsetY = -y0 * pageHeight * scale;
    if (!Float.isFinite((float)scale) || (float)scale <= 0 ||
        !Float.isFinite((float)offsetX) || !Float.isFinite((float)offsetY)) {
      throw new IllegalArgumentException("PDF crop transform cannot be represented");
    }
    return new CropGeometry(Math.max(1, (int)Math.floor(width * scale)),
        Math.max(1, (int)Math.floor(height * scale)), scale, offsetX, offsetY);
  }

  public static void requirePageSize(int actualWidth, int actualHeight,
      double expectedWidth, double expectedHeight) {
    if (actualWidth <= 0 || actualHeight <= 0 || !Double.isFinite(expectedWidth) ||
        !Double.isFinite(expectedHeight) || Math.abs(actualWidth - expectedWidth) >= 1 ||
        Math.abs(actualHeight - expectedHeight) >= 1) {
      throw new IllegalArgumentException("Native PDF page dimensions do not match verified geometry");
    }
  }
}
