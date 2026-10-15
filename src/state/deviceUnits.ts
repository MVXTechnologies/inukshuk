import { defaultUnitsForLocale, type Units } from '@core/format';

/**
 * The first-launch units (#702) from the device's region: miles and feet on a
 * US phone, metric elsewhere. Read from Intl (Hermes reports the device
 * locale, as `deviceSearchLanguage` relies on), so no localization package is
 * needed. Jest pins this to metric in `jest.setup.ts`: the suite must not
 * depend on the CI machine's LANG.
 */
export function deviceDefaultUnits(): Units {
  try {
    return defaultUnitsForLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return defaultUnitsForLocale(null);
  }
}
