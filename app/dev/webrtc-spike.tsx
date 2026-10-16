import { WebRtcSpikeScreen } from '@features/dev/WebRtcSpikeScreen';
import { Redirect } from 'expo-router';

/**
 * G4 WebRTC spike (2.7.0), debug builds only: `inukshuk://dev/webrtc-spike`.
 * Nothing links here; in a release build the deep link lands on the map.
 */
export default function WebRtcSpikeRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <WebRtcSpikeScreen />;
}
