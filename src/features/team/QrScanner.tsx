/**
 * The invite QR scanner (#589): expo-camera's `CameraView` with QR barcode
 * scanning, behind the camera permission. Loaded lazily through
 * `loadQrScanner()` so a binary without the camera module (an OTA onto a
 * pre-2.5.0 build) never imports it — the Join screen then offers paste only.
 */
import { requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';

export interface QrScannerProps {
  /** Called once per distinct code read. */
  onCode: (text: string) => void;
  onClose: () => void;
}

let cached: ComponentType<QrScannerProps> | null | undefined;

export function loadQrScanner(): ComponentType<QrScannerProps> | null {
  if (cached !== undefined) return cached;
  try {
    cached =
      requireOptionalNativeModule('ExpoCamera') === null
        ? null
        : // eslint-disable-next-line @typescript-eslint/no-require-imports
          (require('./QrScannerView') as { QrScannerView: ComponentType<QrScannerProps> })
            .QrScannerView;
  } catch {
    cached = null;
  }
  return cached;
}
