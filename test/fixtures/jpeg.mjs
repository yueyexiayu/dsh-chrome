import jpeg from "jpeg-js";
// Genuine encoded pixels, not a MIME label or magic-byte-only placeholder.
export const JPEG_BYTES = jpeg.encode({ width: 2, height: 2,
  data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) }, 75).data;
export const JPEG = JPEG_BYTES.toString("base64");
