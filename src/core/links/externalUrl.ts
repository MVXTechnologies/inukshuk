/**
 * Which addresses the app may hand to the OS to open (`Linking.openURL`).
 *
 * Many links come from data the app downloads, and some of that data is
 * crowd-edited: a long-distance trail's "Website" is OpenStreetMap's
 * `website` tag, catalog homepages and geodetic datasheet links come from
 * published indexes. `Linking.openURL` opens ANY scheme the OS knows — a deep
 * link into another installed app (or into Inukshuk itself), `tel:`, `sms:`,
 * a store page — so an edited tag could turn a "Website" row into one. Only
 * plain web addresses are opened; everything else is refused.
 */

/** At most this long: a real web address is far shorter, and the OS may choke on more. */
const MAX_URL_LENGTH = 2048;

/**
 * True for an absolute `http(s)://` address with a host and no whitespace or
 * control characters. Case-insensitive on the scheme, as browsers are.
 */
export function isWebUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  // No whitespace or control characters anywhere (a trimmed "https://a b" is not one address).
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return false;
  // A host, then the end or a path/query/fragment. No user-info (`user@host`
  // makes `https://bank.example@evil.example` read as the bank) and no
  // backslash (some parsers treat it as a path separator, others do not).
  return /^https?:\/\/[^/?#@\\]+(?:[/?#]|$)/i.test(url);
}
