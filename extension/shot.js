import { cropSource } from "./crop.js";

const MAX_EDGE = 1280;
const MAX_BYTES = 450_000;

function outputSize(sw, sh) {
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  return {
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale)),
    scale,
  };
}

async function blobOf(canvas, quality) {
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

async function encode(bitmap, source) {
  const size = outputSize(source.sw, source.sh);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法裁剪标注图");
  ctx.drawImage(bitmap, source.sx, source.sy, source.sw, source.sh, 0, 0, size.width, size.height);
  const stroke = source.stroke;
  ctx.strokeStyle = "#e23d3d";
  ctx.lineWidth = Math.max(2, Math.round(3 * source.scale * size.scale));
  ctx.strokeRect(
    stroke.x * size.scale,
    stroke.y * size.scale,
    stroke.width * size.scale,
    stroke.height * size.scale,
  );
  let quality = 0.82;
  let blob = await blobOf(canvas, quality);
  while (blob.size > MAX_BYTES && quality > 0.4) {
    quality -= 0.12;
    blob = await blobOf(canvas, quality);
  }
  if (blob.size > MAX_BYTES) throw new Error("标注图太大");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

export async function jpegCrop(dataUrl, box, viewport) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const source = cropSource(box, viewport, bitmap.width, bitmap.height);
    if (!source) throw new Error("元素不在可视区域");
    return encode(bitmap, source);
  } finally {
    bitmap.close();
  }
}
