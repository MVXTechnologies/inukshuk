import { Directory, File, Paths } from 'expo-file-system';

/**
 * QA builds only: write a JSON report (fluidity numbers, terrain stats) where
 * a harness can pull it off the device/simulator —
 * `<documents>/qa/<name>.json`. Returns the file uri.
 */
export function writeQaReport(name: string, data: unknown): string {
  const dir = new Directory(Paths.document, 'qa');
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, `${name.replace(/[^\w.-]+/g, '_')}.json`);
  file.write(JSON.stringify(data, null, 2));
  return file.uri;
}

/**
 * QA builds only: the pending harness command (a deep-link URL) a host
 * script dropped at `<documents>/qa/command.txt`, or null. The iOS simulator
 * asks "Open in …?" for every `simctl openurl`, so the harness writes here
 * instead.
 */
export function readQaCommand(): string | null {
  try {
    const f = new File(new Directory(Paths.document, 'qa'), 'command.txt');
    if (!f.exists) return null;
    return f.textSync();
  } catch {
    return null;
  }
}
