declare module 'upng-js' {
  interface UPNGImage {
    width: number;
    height: number;
  }
  const UPNG: {
    decode(buffer: ArrayBuffer): UPNGImage;
    toRGBA8(img: UPNGImage): ArrayBuffer[];
    /** Encode RGBA frames to PNG; `cnum` 0 = lossless (no palette quantization). */
    encode(frames: ArrayBuffer[], width: number, height: number, cnum: number): ArrayBuffer;
  };
  export default UPNG;
}
