package expo.modules.inukshukpdf;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;

public final class PrivatePdfFiles {
  private PrivatePdfFiles() {}

  public static boolean within(File file, File directory) throws IOException {
    return file.getCanonicalPath().startsWith(directory.getCanonicalPath() + File.separator);
  }

  public static File input(String fileUri, File filesDir, File cacheDir) throws IOException {
    final URI uri;
    try { uri = new URI(fileUri); }
    catch (URISyntaxException error) { throw new IllegalArgumentException("Invalid PDF file URI", error); }
    if (!"file".equals(uri.getScheme()) || uri.getAuthority() != null ||
        uri.getQuery() != null || uri.getFragment() != null || uri.getPath() == null ||
        !uri.getPath().startsWith("/")) {
      throw new IllegalArgumentException("PDF must be an absolute private file URI");
    }
    File file = new File(uri).getCanonicalFile();
    if ((!within(file, filesDir) && !within(file, cacheDir)) || !file.isFile() || !file.canRead()) {
      throw new IllegalArgumentException("PDF must be a readable file in app-private storage");
    }
    return file;
  }
}
