/**
 * The slice of `react-native-webrtc` the internet carrier uses (2.7.0 G6,
 * #705), typed here so the carrier compiles and is tested against fakes
 * without the package. The real module is reached only through
 * {@link loadRtcModule}: a lazy `require`, so a build without the native
 * module (or a 2.6 binary running a 2.7 bundle, which must not exist) gets
 * `null` and the phone stays nearby-only (design §6, "GroupHost still
 * degrades if RTCPeerConnection is missing").
 */
import type { IceServer } from '@core/group/roomProto';

export interface RtcEventTargetLike {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export interface RtcSessionDescriptionLike {
  readonly type: string;
  readonly sdp: string;
}

export interface RtcIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface RtcDataChannelLike extends RtcEventTargetLike {
  readonly label: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType?: string;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(): void;
}

export interface RtcConfiguration {
  iceServers: IceServer[];
  /** `relay`: TURN only ("Always use the relay", R-RTC-6). */
  iceTransportPolicy: 'all' | 'relay';
  bundlePolicy: 'max-bundle';
}

export interface RtcPeerConnectionLike extends RtcEventTargetLike {
  readonly connectionState: string;
  createDataChannel(
    label: string,
    init?: { ordered?: boolean; maxRetransmits?: number },
  ): RtcDataChannelLike;
  createOffer(): Promise<RtcSessionDescriptionLike>;
  createAnswer(): Promise<RtcSessionDescriptionLike>;
  setLocalDescription(description: RtcSessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: RtcSessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: RtcIceCandidateInit): Promise<void>;
  getStats(): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>>;
  close(): void;
}

export interface RtcModuleLike {
  RTCPeerConnection: new (configuration: RtcConfiguration) => RtcPeerConnectionLike;
}

/**
 * `react-native-webrtc`, loaded on first use; `null` when this binary lacks
 * it (or it fails to load): internet paths are then simply unavailable.
 */
export function loadRtcModule(): RtcModuleLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('react-native-webrtc') as Partial<RtcModuleLike> | undefined;
    return typeof m?.RTCPeerConnection === 'function' ? (m as RtcModuleLike) : null;
  } catch {
    return null;
  }
}
