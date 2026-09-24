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
  return jpegFromCanvas(canvas);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

async function jpegFromCanvas(canvas) {
  let quality = 0.82;
  let blob = await blobOf(canvas, quality);
  while (blob.size > MAX_BYTES && quality > 0.4) {
    quality -= 0.12;
    blob = await blobOf(canvas, quality);
  }
  if (blob.size > MAX_BYTES) throw new Error("标注图太大");
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export async function jpegBoxes(dataUrl, boxes, viewport) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const vw = Number(viewport && viewport.width);
    const vh = Number(viewport && viewport.height);
    if (!(vw > 0 && vh > 0) || !Array.isArray(boxes) || boxes.length === 0) throw new Error("没有可标注的元素");
    const size = outputSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法裁剪标注图");
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const scaleX = (bitmap.width / vw) * size.scale;
    const scaleY = (bitmap.height / vh) * size.scale;
    boxes.forEach((box, index) => {
      const x = Number(box && box.x) * scaleX;
      const y = Number(box && box.y) * scaleY;
      const w = Number(box && box.width) * scaleX;
      const h = Number(box && box.height) * scaleY;
      if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1) return;
      ctx.strokeStyle = "#e23d3d";
      ctx.lineWidth = Math.max(2, Math.round(3 * size.scale));
      ctx.strokeRect(x, y, w, h);
      const label = String(index + 1);
      const font = Math.max(14, Math.round(16 * size.scale));
      ctx.font = `600 ${font}px sans-serif`;
      const pad = 4 * size.scale;
      const labelW = ctx.measureText(label).width + pad * 2;
      const labelH = font + pad;
      const labelY = Math.max(0, y - labelH);
      ctx.fillStyle = "#e23d3d";
      ctx.fillRect(x, labelY, labelW, labelH);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + pad, labelY + font);
    });
    return jpegFromCanvas(canvas);
  } finally {
    bitmap.close();
  }
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
