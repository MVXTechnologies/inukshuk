/**
 * Where "Update Inukshuk" goes (a newer app's invite, 2.7.0 G7): the store
 * app first, its web page when the store app can't open.
 */
export const IOS_APP_STORE_ID = '6797629589';
export const ANDROID_PACKAGE = 'com.inukshuk.app';

export function appStoreLinks(platform: string): { app: string; web: string } {
  return platform === 'ios'
    ? {
        app: `itms-apps://apps.apple.com/app/id${IOS_APP_STORE_ID}`,
        web: `https://apps.apple.com/app/id${IOS_APP_STORE_ID}`,
      }
    : {
        app: `market://details?id=${ANDROID_PACKAGE}`,
        web: `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`,
      };
}
