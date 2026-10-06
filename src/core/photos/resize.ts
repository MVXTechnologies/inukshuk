/**
 * Photo copies (#587): what the app keeps for each photo, and the in-WebView
 * worker page that makes them.
 *
 * Three files per photo, all re-encoded by a canvas, so none carries EXIF
 * (no GPS, no device serial):
 *
 * - **display** — long edge ≤ 2048 px, JPEG q 0.82 (≈ 0.5–0.7 MB): the viewer.
 * - **thumb** — 240 px centre square, JPEG q 0.8 (≈ 15 KB): strips, filmstrip, lane.
 * - **sprite** — 132 px circle (44 pt at 3×) with a light ring and transparent
 *   corners, PNG: the map symbol. The ring is a neutral paper white that reads
 *   on both the light and dark maps, so nothing is regenerated per theme.
 *
 * The page is the same pattern as the PDF rasterizer: one hidden WebView,
 * the source image served from the loopback server (never a `data:` URI —
 * the lesson of #218/#264), results posted back as base64. Browsers draw an
 * `<img>` upright from its EXIF orientation, so the copies are pre-rotated.
 * The page is built here, as a string, so its exact code is unit-tested and
 * timed in desktop Chrome by the resize harness.
 */

export const DISPLAY_MAX_PX = 2048;
export const DISPLAY_QUALITY = 0.82;
export const THUMB_PX = 240;
export const THUMB_QUALITY = 0.8;
export const SPRITE_PX = 132;
/** Ring width inside the sprite, px (≈ 2.3 pt at 3×). */
export const SPRITE_RING_PX = 7;
export const SPRITE_RING_COLOR = '#F7F4EE';

/** Fit `w × h` within a long edge of `maxPx`, never upscaling, at least 1 px. */
export function fitWithin(w: number, h: number, maxPx: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxPx / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The centred square crop of `w × h`, as a source rectangle. */
export function centerSquare(w: number, h: number): { sx: number; sy: number; size: number } {
  const size = Math.min(w, h);
  return { sx: Math.round((w - size) / 2), sy: Math.round((h - size) / 2), size };
}

/** Rough bytes the three copies of one photo take, for the disk check before an import. */
export const ESTIMATED_BYTES_PER_PHOTO = 750 * 1024;

/** A job posted to the worker page. */
export interface ResizeJob {
  id: string;
  /** http(s) URL the page can fetch the source image from (the loopback server). */
  src: string;
}

/** One encoded output. */
export interface ResizeOutput {
  base64: string;
  width: number;
  height: number;
}

/** What the page posts back per job. */
export type ResizeReply =
  | {
      type: 'resized';
      id: string;
      display: ResizeOutput;
      thumb: ResizeOutput;
      sprite: ResizeOutput;
      /** The decoded (upright) source size. */
      sourceWidth: number;
      sourceHeight: number;
      /** Time inside the page: decode, then all three encodes (ms). */
      decodeMs: number;
      encodeMs: number;
    }
  | { type: 'failed'; id: string; message: string }
  | { type: 'ready' };

/** Parse a worker message defensively (anything else → null). */
export function parseResizeReply(data: string): ResizeReply | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (msg === null || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m['type'] === 'ready') return { type: 'ready' };
  if (typeof m['id'] !== 'string') return null;
  if (m['type'] === 'failed') {
    return { type: 'failed', id: m['id'], message: String(m['message'] ?? 'resize failed') };
  }
  if (m['type'] !== 'resized') return null;
  const out = (v: unknown): ResizeOutput | null => {
    if (v === null || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    return typeof o['base64'] === 'string' &&
      o['base64'] !== '' &&
      typeof o['width'] === 'number' &&
      typeof o['height'] === 'number'
      ? { base64: o['base64'], width: o['width'], height: o['height'] }
      : null;
  };
  const display = out(m['display']);
  const thumb = out(m['thumb']);
  const sprite = out(m['sprite']);
  if (!display || !thumb || !sprite) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    type: 'resized',
    id: m['id'],
    display,
    thumb,
    sprite,
    sourceWidth: n(m['sourceWidth']),
    sourceHeight: n(m['sourceHeight']),
    decodeMs: n(m['decodeMs']),
    encodeMs: n(m['encodeMs']),
  };
}

/** The JavaScript that runs a job inside the page: `window.__inukshukResize(job)`. */
export function resizeJobScript(job: ResizeJob): string {
  return `window.__inukshukResize && window.__inukshukResize(${JSON.stringify(job)}); true;`;
}

/**
 * The worker page. Self-contained (no network but the job's `src`), it
 * answers each job with one {@link ResizeReply} through
 * `window.ReactNativeWebView.postMessage`, and posts `ready` once loaded.
 */
export function resizeWorkerHtml(): string {
  const config = JSON.stringify({
    displayMax: DISPLAY_MAX_PX,
    displayQ: DISPLAY_QUALITY,
    thumbPx: THUMB_PX,
    thumbQ: THUMB_QUALITY,
    spritePx: SPRITE_PX,
    ringPx: SPRITE_RING_PX,
    ring: SPRITE_RING_COLOR,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><script>
(function () {
  var C = ${config};
  function post(msg) {
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
    else if (window.__onResizeReply) window.__onResizeReply(s);
  }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function b64(canvas, type, q) {
    var url = canvas.toDataURL(type, q);
    return url.slice(url.indexOf(',') + 1);
  }
  function canvasOf(w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function fit(w, h, max) {
    var s = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }
  // Downscale in halving steps: one big drawImage from 4000 px to 240 px aliases badly.
  function scaled(src, sw, sh, w, h) {
    var cur = src, cw = sw, ch = sh;
    while (cw / 2 >= w && ch / 2 >= h) {
      var half = canvasOf(Math.round(cw / 2), Math.round(ch / 2));
      var hc = half.getContext('2d'); hc.imageSmoothingQuality = 'high';
      hc.drawImage(cur, 0, 0, cw, ch, 0, 0, half.width, half.height);
      cur = half; cw = half.width; ch = half.height;
    }
    var out = canvasOf(w, h); var oc = out.getContext('2d'); oc.imageSmoothingQuality = 'high';
    oc.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h);
    return out;
  }
  window.__inukshukResize = function (job) {
    var t0 = now();
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = function () { post({ type: 'failed', id: job.id, message: 'could not decode the image' }); };
    img.onload = function () {
      try {
        var t1 = now();
        var sw = img.naturalWidth, sh = img.naturalHeight;
        if (!(sw > 0 && sh > 0)) throw new Error('empty image');
        var d = fit(sw, sh, C.displayMax);
        var display = scaled(img, sw, sh, d.w, d.h);
        var side = Math.min(d.w, d.h);
        var sq = canvasOf(side, side);
        sq.getContext('2d').drawImage(display, Math.round((d.w - side) / 2), Math.round((d.h - side) / 2), side, side, 0, 0, side, side);
        var thumb = scaled(sq, side, side, Math.min(C.thumbPx, side), Math.min(C.thumbPx, side));
        var S = C.spritePx, r = S / 2;
        var sprite = canvasOf(S, S); var sc = sprite.getContext('2d');
        sc.beginPath(); sc.arc(r, r, r, 0, Math.PI * 2); sc.fillStyle = C.ring; sc.fill();
        sc.save(); sc.beginPath(); sc.arc(r, r, r - C.ringPx, 0, Math.PI * 2); sc.clip();
        var inner = scaled(sq, side, side, S, S);
        sc.drawImage(inner, 0, 0); sc.restore();
        var reply = {
          type: 'resized', id: job.id,
          display: { base64: b64(display, 'image/jpeg', C.displayQ), width: d.w, height: d.h },
          thumb: { base64: b64(thumb, 'image/jpeg', C.thumbQ), width: thumb.width, height: thumb.height },
          sprite: { base64: b64(sprite, 'image/png'), width: S, height: S },
          sourceWidth: sw, sourceHeight: sh,
          decodeMs: Math.round(t1 - t0), encodeMs: Math.round(now() - t1)
        };
        post(reply);
      } catch (e) {
        post({ type: 'failed', id: job.id, message: String((e && e.message) || e) });
      }
    };
    img.src = job.src;
  };
  post({ type: 'ready' });
})();
</script></body></html>`;
}
