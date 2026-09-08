import type { PdfCrop } from '@core/geo/pdfDetail';
import { reportError } from '@lib/errorReporting';
import { requireOptionalNativeModule } from 'expo';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

export interface NativePdfCropArgs {
  fileUri: string;
  pageIndex: number;
  pageWidthPt: number;
  pageHeightPt: number;
  crop: PdfCrop;
  targetWidthPx: number;
}
export interface NativePdfCropResult {
  fileUri: string;
  widthPx: number;
  heightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
  pageCount: number;
  loadMs: number;
  renderMs: number;
}
interface NativePdfModule {
  renderCrop(args: NativePdfCropArgs): Promise<NativePdfCropResult>;
}
function nativeModule(): NativePdfModule | null {
  return Platform.OS === 'android' || Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativePdfModule>('InukshukPdf')
    : null;
}
/** Optional so existing binaries and other platforms retain PDF.js rendering. */
export function nativePdfAvailable(): boolean {
  return nativeModule() !== null;
}
export async function renderNativePdfCrop(args: NativePdfCropArgs): Promise<NativePdfCropResult> {
  const module = nativeModule();
  if (!module) throw new Error('Native PDF renderer unavailable');
  return module.renderCrop(args);
}
/** Only called for a native output whose ownership was never handed to the cache. */
export function deleteNativePdfOutput(fileUri: string): void {
  try {
    const file = new File(fileUri);
    if (file.exists) file.delete();
  } catch (error) {
    reportError(error, 'pdf-detail-cleanup');
  }
}
