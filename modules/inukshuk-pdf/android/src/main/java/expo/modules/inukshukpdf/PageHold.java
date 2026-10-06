package expo.modules.inukshukpdf;

/**
 * One open resource (a PDF document and page) kept between crops of the same
 * page. Opening a page with PdfRenderer parses its content: on a US Topo sheet
 * that is most of a small crop's cost, so a burst of crops of one page opens it
 * once. A request for another key closes the held one first; release() closes
 * it outright (idle, failure, memory pressure, teardown).
 *
 * Not thread-safe by itself beyond its own monitor: the module confines it to
 * its single render thread.
 */
public final class PageHold<T> {
  public interface Opener<T> { T open() throws Exception; }
  public interface Closer<T> { void close(T value); }

  private final Closer<T> closer;
  private String key;
  private T value;

  public PageHold(Closer<T> closer) { this.closer = closer; }

  /**
   * The identity of a page of a file: a replaced file (another size or
   * modification time at the same path) never reuses the old document.
   */
  public static String key(String canonicalPath, long length, long lastModified, int pageIndex) {
    return canonicalPath + '|' + length + '|' + lastModified + '|' + pageIndex;
  }

  /** The held value for {@code key}, or a freshly opened one (closing any other first). */
  public synchronized T acquire(String key, Opener<T> opener) throws Exception {
    if (value != null && key.equals(this.key)) return value;
    release();
    T opened = opener.open();
    this.key = key;
    this.value = opened;
    return opened;
  }

  /** Closes the held value, if any. Safe to call any number of times. */
  public synchronized void release() {
    T held = value;
    value = null;
    key = null;
    if (held != null) closer.close(held);
  }

  public synchronized boolean holds(String key) {
    return value != null && key.equals(this.key);
  }
}
