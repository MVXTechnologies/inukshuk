declare module 'jpeg-js' {
  interface RawImageData {
    width: number;
    height: number;
    data: Uint8Array;
  }
  const jpeg: {
    decode(data: ArrayBuffer | Uint8Array, opts?: { useTArray?: boolean }): RawImageData;
    /**
     * NOTE: the encoder returns `Buffer.from(...)` under CommonJS — a Buffer
     * global must exist on Hermes (composeMapPdf installs the `buffer`
     * package's implementation before calling this).
     */
    encode(img: RawImageData, quality?: number): RawImageData;
  };
  export default jpeg;
}
