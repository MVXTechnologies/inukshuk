/**
 * A file name a person can read for a file handed to another app (2.5.2 QA):
 * stored files are named by a random id, which is what the viewer and the
 * share sheet showed. The item's title, minus what file systems refuse
 * (`/ \ : * ? " < > |`, control characters), trimmed, at most 80 characters,
 * and the extension; `fallback` when nothing is left. PURE.
 */
export function shareFileName(title: string, extension: string, fallback: string): string {
  const cleaned = Array.from(title)
    .map((ch) => (/[/\\:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 0x20 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  const base = Array.from(cleaned).slice(0, 80).join('').trim();
  return `${base === '' ? fallback : base}.${extension}`;
}

/** A map's PDF under its title: `Rivière du Nord 2022.pdf`. */
export function pdfShareName(title: string): string {
  return shareFileName(title, 'pdf', 'Map');
}
