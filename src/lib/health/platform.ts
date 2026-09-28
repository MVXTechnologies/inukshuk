import type { HealthPlatform } from './platform.types';

/**
 * No health store (web, and the base file TypeScript resolves). The real
 * implementations are `platform.ios.ts` / `platform.android.ts`, chosen by
 * Metro's platform extensions so neither bundle contains the other
 * platform's native library.
 */
export const healthPlatform: HealthPlatform | null = null;
