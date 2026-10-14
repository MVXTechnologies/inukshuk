/**
 * A file name a person can read for a map handed to another app (2.5.2 QA):
 * the stored PDF is named by a random id, which is what the viewer and the
 * share sheet showed. The map's title, minus what file systems refuse
 * (`/ \ : * ? " < > |`, control characters), trimmed, at most 80 characters,
 * and `.pdf`. PURE.
 */
export function pdfShareName(title: string): string {
  const cleaned = Array.from(title)
    .map((ch) => (/[/\\:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 0x20 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  const base = Array.from(cleaned).slice(0, 80).join('').trim();
  return `${base === '' ? 'Map' : base}.pdf`;
}
