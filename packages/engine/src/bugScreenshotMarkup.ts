/**
 * Burn a red bounding box into bug JPEGs when the model provides a region.
 * Review/filmstrip prompts use 0–1000 normalized coords; if the box does not fit
 * that square, values are treated as pixel coordinates.
 */
import sharp from "sharp";
import { logger } from "./logger.js";

export type BugRegion = { x: number; y: number; w: number; h: number };

function regionToPixelRect(region: BugRegion, imgW: number, imgH: number): { left: number; top: number; width: number; height: number } {
  const { x, y, w, h } = region;
  const fitsNormalized =
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 1000 &&
    y + h <= 1000;
  if (fitsNormalized) {
    return {
      left: Math.round((x / 1000) * imgW),
      top: Math.round((y / 1000) * imgH),
      width: Math.round((w / 1000) * imgW),
      height: Math.round((h / 1000) * imgH),
    };
  }
  return {
    left: Math.round(x),
    top: Math.round(y),
    width: Math.round(w),
    height: Math.round(h),
  };
}

/**
 * Draw a red stroke rectangle on a JPEG buffer and return a new JPEG buffer.
 * On failure, returns the original buffer.
 */
export async function drawRedBoundingBoxOnJpeg(jpegBuffer: Buffer, region: BugRegion): Promise<Buffer> {
  try {
    const meta = await sharp(jpegBuffer).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw < 2 || ih < 2) return jpegBuffer;

    let { left, top, width, height } = regionToPixelRect(region, iw, ih);
    left = Math.max(0, Math.min(left, iw - 1));
    top = Math.max(0, Math.min(top, ih - 1));
    width = Math.max(1, Math.min(width, iw - left));
    height = Math.max(1, Math.min(height, ih - top));

    const stroke = Math.max(2, Math.round(Math.min(iw, ih) / 400));
    const svg = `<svg width="${iw}" height="${ih}" xmlns="http://www.w3.org/2000/svg">
<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="none" stroke="rgb(255,0,0)" stroke-width="${stroke}"/>
</svg>`;

    return sharp(jpegBuffer)
      .composite([{ input: Buffer.from(svg), blend: "over" }])
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    logger.warn({ err: String(err) }, "drawRedBoundingBoxOnJpeg: failed, using original JPEG");
    return jpegBuffer;
  }
}
