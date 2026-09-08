package expo.modules.inukshukpdf;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

public final class PrivatePdfFilesTest {
  interface Checked { void run() throws Exception; }
  private static void rejects(Checked action) throws Exception {
    try { action.run(); } catch (IllegalArgumentException expected) { return; }
    throw new AssertionError("Unsafe path accepted");
  }
  public static void main(String[] args) throws Exception {
    Path root = Files.createTempDirectory("pdf-paths");
    File files = Files.createDirectory(root.resolve("files")).toFile();
    File cache = Files.createDirectory(root.resolve("cache")).toFile();
    File pdf = Files.write(files.toPath().resolve("a b.pdf"), new byte[]{1}).toFile();
    File external = Files.write(root.resolve("outside.pdf"), new byte[]{1}).toFile();
    Path link = files.toPath().resolve("escape.pdf");
    Files.createSymbolicLink(link, external.toPath());
    try {
      if (!PrivatePdfFiles.input(pdf.toURI().toString(), files, cache).equals(pdf.getCanonicalFile())) throw new AssertionError("Valid encoded private URI");
      rejects(() -> PrivatePdfFiles.input(external.toURI().toString(), files, cache));
      rejects(() -> PrivatePdfFiles.input(link.toUri().toString(), files, cache));
      rejects(() -> PrivatePdfFiles.input("https://example.com/a.pdf", files, cache));
      rejects(() -> PrivatePdfFiles.input("content://provider/a.pdf", files, cache));
      rejects(() -> PrivatePdfFiles.input(pdf.toURI() + "?query", files, cache));
      rejects(() -> PrivatePdfFiles.input(pdf.toURI() + "#fragment", files, cache));
      rejects(() -> PrivatePdfFiles.input(files.toURI().toString(), files, cache));
      rejects(() -> PrivatePdfFiles.input("file://host" + pdf.getAbsolutePath(), files, cache));
      File sibling = Files.createDirectory(root.resolve("files-extra")).toFile();
      File siblingPdf = Files.write(sibling.toPath().resolve("a.pdf"), new byte[]{1}).toFile();
      rejects(() -> PrivatePdfFiles.input(siblingPdf.toURI().toString(), files, cache));
      Files.delete(siblingPdf.toPath()); Files.delete(sibling.toPath());
      System.out.println("Private PDF URI checks passed: 10");
    } finally {
      Files.delete(link); Files.delete(pdf.toPath()); Files.delete(external.toPath());
      Files.delete(files.toPath()); Files.delete(cache.toPath()); Files.delete(root);
    }
  }
}
