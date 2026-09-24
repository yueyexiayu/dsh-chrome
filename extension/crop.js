/** Visible-tab crop in image pixels. box and viewport are CSS pixels. */
export function cropSource(box, viewport, imageWidth, imageHeight, pad = 8) {
  const vw = Number(viewport && viewport.width);
  const vh = Number(viewport && viewport.height);
  const iw = Number(imageWidth);
  const ih = Number(imageHeight);
  if (!(vw > 0 && vh > 0 && iw > 0 && ih > 0)) return null;
  const left = Number(box && box.x);
  const top = Number(box && box.y);
  const width = Number(box && box.width);
  const height = Number(box && box.height);
  if (![left, top, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;

  const visLeft = Math.max(0, left);
  const visTop = Math.max(0, top);
  const visRight = Math.min(vw, left + width);
  const visBottom = Math.min(vh, top + height);
  if (visRight - visLeft < 1 || visBottom - visTop < 1) return null;

  const scaleX = iw / vw;
  const scaleY = ih / vh;
  const sx = Math.max(0, Math.floor(visLeft * scaleX - pad * scaleX));
  const sy = Math.max(0, Math.floor(visTop * scaleY - pad * scaleY));
  const sr = Math.min(iw, Math.ceil(visRight * scaleX + pad * scaleX));
  const sb = Math.min(ih, Math.ceil(visBottom * scaleY + pad * scaleY));
  const sw = sr - sx;
  const sh = sb - sy;
  if (sw < 1 || sh < 1) return null;
  return {
    sx,
    sy,
    sw,
    sh,
    stroke: {
      x: visLeft * scaleX - sx,
      y: visTop * scaleY - sy,
      width: (visRight - visLeft) * scaleX,
      height: (visBottom - visTop) * scaleY,
    },
    scale: Math.max(scaleX, scaleY),
  };
}
