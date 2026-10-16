import { appStoreLinks } from './appStore';

it('opens the App Store page of Inukshuk on iOS, Google Play on Android', () => {
  expect(appStoreLinks('ios')).toEqual({
    app: 'itms-apps://apps.apple.com/app/id6797629589',
    web: 'https://apps.apple.com/app/id6797629589',
  });
  expect(appStoreLinks('android')).toEqual({
    app: 'market://details?id=com.inukshuk.app',
    web: 'https://play.google.com/store/apps/details?id=com.inukshuk.app',
  });
});
