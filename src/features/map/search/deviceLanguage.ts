import { searchLanguage } from '@core/search/query';

/**
 * The language place names are asked in: French on a French device, English
 * otherwise. Read from Intl (Hermes reports the device locale), so no
 * localization package is needed.
 */
export function deviceSearchLanguage(): 'fr' | 'en' {
  try {
    return searchLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return 'en';
  }
}
