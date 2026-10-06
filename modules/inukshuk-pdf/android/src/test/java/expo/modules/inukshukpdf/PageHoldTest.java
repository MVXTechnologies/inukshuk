package expo.modules.inukshukpdf;

import java.util.ArrayList;
import java.util.List;

/** Host-JVM checks for the held page; no Android runtime required. */
public final class PageHoldTest {
  private static int checks;
  private static void check(boolean ok, String what) {
    checks++;
    if (!ok) throw new AssertionError(what);
  }

  public static void main(String[] args) throws Exception {
    List<String> opened = new ArrayList<>();
    List<String> closed = new ArrayList<>();
    PageHold<String> hold = new PageHold<>(closed::add);
    String a = PageHold.key("/data/maps/a.pdf", 100, 1, 0);
    String a1 = PageHold.key("/data/maps/a.pdf", 100, 1, 1);
    String replaced = PageHold.key("/data/maps/a.pdf", 101, 2, 0);

    // A burst of crops of one page opens it once.
    for (int i = 0; i < 3; i++) hold.acquire(a, () -> { opened.add("a"); return "doc-a"; });
    check(opened.size() == 1, "opened once for a burst");
    check(closed.isEmpty(), "nothing closed during the burst");
    check(hold.holds(a), "holds the page");

    // Another page of the same file closes the first.
    check(hold.acquire(a1, () -> { opened.add("a1"); return "doc-a1"; }).equals("doc-a1"), "returns the new page");
    check(closed.size() == 1 && closed.get(0).equals("doc-a"), "closed the previous page");

    // A replaced file never reuses the old document.
    check(!a.equals(replaced), "size/mtime are part of the key");
    hold.acquire(replaced, () -> { opened.add("r"); return "doc-r"; });
    check(opened.size() == 3, "a replaced file is opened afresh");

    // Release closes once and is idempotent.
    hold.release();
    hold.release();
    check(closed.size() == 3 && closed.get(2).equals("doc-r"), "release closes the held page once");
    check(!hold.holds(replaced), "nothing held after release");

    // A failed open holds nothing and closes nothing more.
    try {
      hold.acquire(a, () -> { throw new IllegalStateException("bad pdf"); });
      check(false, "open failure propagates");
    } catch (IllegalStateException expected) {
      check(!hold.holds(a), "a failed open holds nothing");
    }
    check(closed.size() == 3, "no stray close after a failed open");
    System.out.println("PageHoldTest: " + checks + " checks passed");
  }
}
