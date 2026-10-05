import { ConvertSelfTestScreen } from '@features/convert/ConvertSelfTestScreen';

/** The on-device Convert regression gate (scripts/convert-native-suite.sh). Inert without its test data. */
export default function ConvertSelfTestRoute() {
  return <ConvertSelfTestScreen />;
}
