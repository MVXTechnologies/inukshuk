/**
 * Optional-content (PDF layer) handling for the overlay rasterizer.
 *
 * GeoPDFs such as USGS US Topo sheets carry their content in optional-content
 * groups (OCGs): "Orthoimage", "Shaded Relief", "Contours", "Transportation"…
 * A Portland West, ME sheet (58 MB) holds ~107 Mpx of orthoimage JPEG strips
 * and a single 105 Mpx shaded-relief JPEG, BOTH hidden by the document's own
 * default layer state. pdf.js (3.11 and 6.x alike) honours that state only
 * when painting: its worker still decodes every hidden image while building
 * the operator list. Measured in Node on that sheet with 3.11, that was
 * ~4.5 s of JPEG decoding (and a transient ~300 MB RGB buffer for the relief)
 * for pixels nobody sees.
 *
 * Two pieces live here, both as plain ES5 **source text**: the rasterizer runs
 * them inside the WebView page and the pdf.js worker, and Hermes cannot turn
 * a compiled function back into source (the same constraint as
 * `rasterCropGeometry`).
 *
 * - `__inkPlanLayers(groups, prefs)` — the layer rules: which groups to force
 *   on/off on top of the document's defaults (aerial imagery off unless the
 *   user asked for it).
 * - `__inkOC` — the worker-side filter: given the final visibility of every
 *   group, it answers pdf.js' own visibility question for a marked-content
 *   section (same semantics as pdf.js' `OptionalContentConfig.isVisible`), so
 *   the patched evaluator (`pdfWorkerPatch.ts`) can skip images, shadings and
 *   form XObjects that would never be painted.
 *
 * `loadPdfLayerRuntime()` evaluates the same text for tests and Node tools.
 */

/** A PDF optional-content group as the rasterizer page sees it. */
export interface PdfLayerGroup {
  /** pdf.js group id (the OCG's object reference, e.g. `"252R"`). */
  id: string;
  name: string | null;
  /** The document's default visibility. */
  visible: boolean;
}

/** Per-map layer preferences. */
export interface PdfLayerPrefs {
  /** Draw aerial/orthoimagery layers. Off by default: slow and memory-hungry. */
  showImagery: boolean;
}

export const DEFAULT_PDF_LAYER_PREFS: PdfLayerPrefs = { showImagery: false };

export interface PdfLayerPlan {
  /** Final visibility of every group, keyed by id. */
  visibility: Record<string, boolean>;
  /** Ids whose final visibility differs from the document default. */
  changed: string[];
  /**
   * The changes that can alter what the page draws. Imagery switched off
   * while the document's own "Images" parent group is already off changes
   * nothing: US Topo nests its orthoimage under that parent, and both must be
   * on for it to draw (#477). A native renderer, which draws the document's
   * default layers, gives the same picture when this is empty — so a 2024
   * US Topo sheet keeps its native detail tiles, as before #478.
   */
  drawnChanged: string[];
}

/** pdf.js' parsed `/OC` marked-content properties. */
export type PdfOptionalContent =
  | { type: 'OCG'; id: string }
  | {
      type: 'OCMD';
      id?: string;
      ids?: string[];
      policy?: string | null;
      expression?: unknown[] | null;
    };

/**
 * The per-call key the filter keeps its section state on: pdf.js' content
 * stream preprocessor, which is new for every `getOperatorList` call (a form
 * XObject's content is a nested call with its own). An opaque object here.
 */
export type PdfOperatorListKey = object;

export interface PdfOptionalContentFilter {
  /**
   * Install the final visibility map, and the codes of the operators that may
   * be dropped inside hidden content (pdf.js' own `OPS`); `null` disables
   * filtering.
   */
  set(visibility: Record<string, boolean> | null, ops?: PdfOpsLike | null): void;
  visible(group: PdfOptionalContent | null | undefined): boolean;
  /**
   * Called for every content-stream operator before pdf.js handles it, with
   * pdf.js' own marked-content depth at that point. Returns true when the
   * operator paints inside hidden content and can be dropped.
   */
  op(key: PdfOperatorListKey, fn: number, level: number): boolean;
  /** Called when pdf.js adds a parsed `/OC` section that opened depth `level`. */
  push(key: PdfOperatorListKey, group: PdfOptionalContent | null | undefined, level: number): void;
}

/** The operators the filter may drop: everything that fetches or decodes. */
export interface PdfOpsLike {
  paintXObject: number;
  endInlineImage: number;
  shadingFill: number;
}

/**
 * ES5 source defining `__inkOC`, `__inkPlanLayers` and `__inkImageryLayer`,
 * exported on the global object (the worker's global scope, or `window` in the
 * page) — the patched worker reads `__inkOC` as a bare global.
 *
 * Layer names that count as aerial imagery: "Orthoimage", "Orthoimagery",
 * "Aerial Imagery", "Aerial Photo(s/graph(s)/graphy)", "Satellite (Imagery)",
 * "Imagery". A bare "Images"/"Image" group is NOT treated as imagery on its
 * own (a scanned map may call its only layer that) — it is only switched on
 * together with an imagery layer, because US Topo nests "Orthoimage" under an
 * "Images" parent that is off by default (both must be on to draw it).
 */
export const PDF_LAYER_RUNTIME_SOURCE = String.raw`(function (root) {
  'use strict';
  var IMAGERY = /^\s*(ortho[\s_-]*(image|imagery|images|photo(s|graphs?|graphy)?)|aerial([\s_-]*(image|imagery|images|photo(s|graphs?|graphy)?))?|satellite([\s_-]*(image|imagery|images))?|imagery)\s*$/i;
  var IMAGE_PARENT = /^\s*images?\s*$/i;
  function isImagery(name) { return typeof name === 'string' && IMAGERY.test(name); }

  function planLayers(groups, prefs) {
    var show = !!(prefs && prefs.showImagery);
    var list = Array.isArray(groups) ? groups : [];
    var hasImagery = false;
    for (var i = 0; i < list.length; i++) if (list[i] && isImagery(list[i].name)) hasImagery = true;
    var visibility = {};
    var changed = [];
    var drawnChanged = [];
    var parentOff = false;
    for (var k = 0; k < list.length; k++) {
      var p = list[k];
      if (p && typeof p.name === 'string' && IMAGE_PARENT.test(p.name) && !p.visible) parentOff = true;
    }
    for (var j = 0; j < list.length; j++) {
      var g = list[j];
      if (!g || typeof g.id !== 'string') continue;
      var v = !!g.visible;
      if (isImagery(g.name)) v = show;
      else if (show && hasImagery && typeof g.name === 'string' && IMAGE_PARENT.test(g.name)) v = true;
      visibility[g.id] = v;
      if (v !== !!g.visible) {
        changed.push(g.id);
        if (v || !parentOff || !isImagery(g.name)) drawnChanged.push(g.id);
      }
    }
    return { visibility: visibility, changed: changed, drawnChanged: drawnChanged };
  }

  // Mirrors pdf.js' OptionalContentConfig.isVisible: unknown groups and malformed
  // input count as visible, so the filter can only ever drop content pdf.js
  // itself would hide.
  var vis = null;
  function known(id) { return vis !== null && Object.prototype.hasOwnProperty.call(vis, id); }
  function expression(array) {
    if (!Array.isArray(array) || array.length < 2) return true;
    var operator = array[0];
    for (var i = 1; i < array.length; i++) {
      var element = array[i];
      var state;
      if (Array.isArray(element)) state = expression(element);
      else if (known(element)) state = vis[element];
      else return true;
      if (operator === 'And') { if (!state) return false; }
      else if (operator === 'Or') { if (state) return true; }
      else if (operator === 'Not') return !state;
      else return true;
    }
    return operator === 'And';
  }
  function visible(group) {
    if (vis === null || !group) return true;
    if (group.type === 'OCG') return known(group.id) ? vis[group.id] : true;
    if (group.type !== 'OCMD') return true;
    if (group.expression) return expression(group.expression);
    var ids = group.ids;
    if (!Array.isArray(ids)) return group.id && known(group.id) ? vis[group.id] : true;
    var policy = group.policy || 'AnyOn';
    for (var i = 0; i < ids.length; i++) if (!known(ids[i])) return true;
    var k;
    if (policy === 'AnyOn') { for (k = 0; k < ids.length; k++) if (vis[ids[k]]) return true; return false; }
    if (policy === 'AllOn') { for (k = 0; k < ids.length; k++) if (!vis[ids[k]]) return false; return true; }
    if (policy === 'AnyOff') { for (k = 0; k < ids.length; k++) if (!vis[ids[k]]) return true; return false; }
    if (policy === 'AllOff') { for (k = 0; k < ids.length; k++) if (vis[ids[k]]) return false; return true; }
    return true;
  }
  // Section visibility per getOperatorList call, indexed by the depth the
  // section opened: open[d] is false when the section that brought pdf.js'
  // marked-content depth to d is hidden. pdf.js' own depth counter is the
  // source of truth, so a tag it ignores, or an EMC it skips, can never put
  // this out of step with it. Entries deeper than the current depth belong
  // to sections that have closed and are discarded.
  var drop = null;
  function sections(key, level) {
    var s = key.__inkOC;
    if (!s) { s = []; key.__inkOC = s; }
    if (s.length > level + 1) s.length = level + 1;
    return s;
  }
  var filter = {
    set: function (v, ops) {
      vis = v && typeof v === 'object' ? v : null;
      drop = null;
      if (vis !== null && ops && typeof ops === 'object') {
        drop = {};
        var names = ['paintXObject', 'endInlineImage', 'shadingFill'];
        for (var i = 0; i < names.length; i++) {
          if (typeof ops[names[i]] === 'number') drop[ops[names[i]]] = true;
        }
      }
    },
    visible: function (group) {
      try { return visible(group); } catch (e) { return true; }
    },
    push: function (key, group, level) {
      try {
        if (typeof level !== 'number' || level < 1) return;
        sections(key, level)[level] = visible(group);
      } catch (e) {}
    },
    op: function (key, fn, level) {
      try {
        if (typeof level !== 'number' || level < 0) return false;
        var s = sections(key, level);
        if (vis === null || drop === null || drop[fn] !== true) return false;
        for (var i = 1; i < s.length; i++) if (s[i] === false) return true;
      } catch (e) {}
      return false;
    },
  };

  root.__inkOC = filter;
  root.__inkPlanLayers = planLayers;
  root.__inkImageryLayer = isImagery;
  if (root.addEventListener) {
    // The page hands the worker its visibility map before asking for the
    // operator list (same port, so ordered). pdf.js ignores messages that
    // carry no targetName.
    root.addEventListener('message', function (event) {
      var data = event && event.data;
      if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'inukshukOptionalContent')) {
        filter.set(data.inukshukOptionalContent, data.inukshukOps);
      }
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
`;

export interface PdfLayerRuntime {
  filter: PdfOptionalContentFilter;
  planLayers(groups: readonly PdfLayerGroup[], prefs: PdfLayerPrefs): PdfLayerPlan;
  isImageryLayer(name: string | null): boolean;
}

/**
 * Evaluate {@link PDF_LAYER_RUNTIME_SOURCE} against a private global and return
 * its exports (tests, Node benchmarks). The app never calls this: it ships the
 * source text to the WebView.
 */
export function loadPdfLayerRuntime(): PdfLayerRuntime {
  const root: Record<string, unknown> = {};
  // A Function body, not eval: `self`/`globalThis` are shadowed by the
  // parameters so the runtime installs itself on `root` only.
  new Function('self', 'globalThis', PDF_LAYER_RUNTIME_SOURCE)(root, root);
  return {
    filter: root.__inkOC as PdfOptionalContentFilter,
    planLayers: root.__inkPlanLayers as PdfLayerRuntime['planLayers'],
    isImageryLayer: root.__inkImageryLayer as PdfLayerRuntime['isImageryLayer'],
  };
}
