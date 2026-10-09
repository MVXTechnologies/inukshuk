/**
 * Detects Android's "<app> isn't responding" (ANR) system dialog in a UI
 * hierarchy, so the E2E runner can dismiss it instead of failing every flow
 * behind it (run 37914205449: "Pixel Launcher isn't responding" covered the
 * app for a whole shard).
 *
 * Detection rests on what was OBSERVED in that run's Maestro hierarchy: the
 * dialog's buttons carry the resource ids `android:id/aerr_close` ("Close
 * app") and `android:id/aerr_wait` ("Wait"), and its title is
 * `android:id/alertTitle` ("Pixel Launcher isn't responding"). Both input
 * shapes are accepted: `uiautomator dump` XML (what the runner reads on the
 * device) and Maestro's JSON hierarchy (what the artifact holds).
 */

/** Flat list of `{ 'resource-id', text, bounds, ... }` attribute maps. */
export function parseNodes(input) {
  const src = String(input).trim();
  if (src.startsWith('{') || src.startsWith('[')) {
    const nodes = [];
    const walk = (n) => {
      if (n && typeof n === 'object') {
        if (n.attributes && typeof n.attributes === 'object') nodes.push(n.attributes);
        for (const c of n.children ?? []) walk(c);
      }
    };
    walk(JSON.parse(src));
    return nodes;
  }
  const nodes = [];
  for (const tag of src.match(/<node\b[^>]*>/g) ?? []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[m[1]] = m[2]
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    }
    nodes.push(attrs);
  }
  return nodes;
}

/** Centre of a "[l,t][r,b]" bounds string, or null. */
export function center(bounds) {
  const m = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds ?? '');
  if (!m) return null;
  const [l, t, r, b] = m.slice(1).map(Number);
  return [Math.round((l + r) / 2), Math.round((t + b) / 2)];
}

/**
 * @returns null when no ANR dialog is on screen, else
 *   { title, ownApp, close: [x, y] | null, wait: [x, y] | null }
 * `ownApp` is true when the title names the app under test (`appLabel`): that
 * ANR is a real defect and must never be dismissed by closing the app.
 */
export function findAnrDialog(input, appLabel = 'Inukshuk') {
  const nodes = parseNodes(input);
  const byId = (id) => nodes.find((n) => n['resource-id'] === id);
  const closeBtn = byId('android:id/aerr_close');
  const waitBtn = byId('android:id/aerr_wait');
  if (!closeBtn && !waitBtn) return null;
  const title = byId('android:id/alertTitle')?.text ?? '';
  return {
    title,
    ownApp: title.toLowerCase().startsWith(`${appLabel.toLowerCase()} `),
    close: closeBtn ? center(closeBtn.bounds) : null,
    wait: waitBtn ? center(waitBtn.bounds) : null,
  };
}
