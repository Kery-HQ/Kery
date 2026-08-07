/**
 * Turn a bug's raw screenshot into the clearest possible evidence image.
 *
 * The best version zooms into the affected area (so the reader isn't hunting a
 * small box on a full-page shot), draws the red box, and prints a short caption
 * of what went wrong / what should have happened. Everything is best-effort with
 * a strict fallback chain, so a bug always gets *an* image:
 *
 *   best      zoomed crop + red box + caption
 *   fallback  red box on the full screenshot
 *   fallback  the plain screenshot, untouched
 *
 * Review/filmstrip prompts use 0–1000 normalized coords on both axes; anything
 * outside that range means the model broke the contract, so we never draw at a
 * guessed position — we drop to a lower rung instead.
 */
import sharp from "sharp";
import { logger } from "./logger.js";

export type BugRegion = { x: number; y: number; w: number; h: number };

export type IssueCaption = {
  /** One-line title of the defect (e.g. the bug name). */
  headline?: string;
  /** What the app should have done. */
  expected?: string;
  /** What it actually did. */
  found?: string;
};

function regionToPixelRect(
  region: BugRegion,
  imgW: number,
  imgH: number,
): { left: number; top: number; width: number; height: number } | null {
  const { x, y, w, h } = region;
  const isValid = x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1000 && y + h <= 1000;
  if (!isValid) return null;
  return {
    left: Math.round((x / 1000) * imgW),
    top: Math.round((y / 1000) * imgH),
    width: Math.round((w / 1000) * imgW),
    height: Math.round((h / 1000) * imgH),
  };
}

function esc(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Greedy word-wrap to a character budget per line, capped at maxLines. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= perLine) cur += " " + w;
    else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && (words.join(" ").length > lines.join(" ").length)) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, "…");
  }
  return lines;
}

/**
 * Build the caption bar as an SVG the width of the image. Returns the SVG
 * string and its pixel height, or null when there's nothing worth printing.
 */
function captionBar(caption: IssueCaption, width: number): { svg: string; height: number } | null {
  const rows: Array<{ label: string; text: string; color: string }> = [];
  if (caption.headline?.trim()) rows.push({ label: "", text: caption.headline.trim(), color: "#f4f4f5" });
  if (caption.expected?.trim()) rows.push({ label: "Expected", text: caption.expected.trim(), color: "#86efac" });
  if (caption.found?.trim()) rows.push({ label: "Found", text: caption.found.trim(), color: "#fca5a5" });
  if (rows.length === 0) return null;

  const pad = Math.round(width * 0.02);
  const fontSize = Math.max(13, Math.round(width / 45));
  const lineH = Math.round(fontSize * 1.35);
  const perLine = Math.max(24, Math.floor((width - pad * 2) / (fontSize * 0.56)));

  // A lone description gets more room (3 lines) so it isn't clipped; when it
  // shares the bar with Expected/Found, each row stays tight at 2.
  const soloHeadline = rows.length === 1 && !rows[0].label;
  const lineEls: string[] = [];
  let y = pad + fontSize;
  for (const row of rows) {
    const prefix = row.label ? `${row.label}: ` : "";
    const wrapped = wrap(prefix + row.text, perLine, soloHeadline ? 3 : 2);
    for (const ln of wrapped) {
      lineEls.push(`<text x="${pad}" y="${y}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${fontSize}" font-weight="${row.label ? 500 : 600}" fill="${row.color}">${esc(ln)}</text>`);
      y += lineH;
    }
  }
  const height = y - fontSize + pad;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#18181b"/>${lineEls.join("")}</svg>`;
  return { svg, height };
}

/** Legacy: red stroke rect on the full JPEG. Kept as a fallback rung. */
export async function drawRedBoundingBoxOnJpeg(jpegBuffer: Buffer, region: BugRegion): Promise<Buffer> {
  try {
    const meta = await sharp(jpegBuffer).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw < 2 || ih < 2) return jpegBuffer;
    const rect = regionToPixelRect(region, iw, ih);
    if (!rect) {
      logger.warn({ region }, "drawRedBoundingBoxOnJpeg: region outside 0-1000 range, skipping box");
      return jpegBuffer;
    }
    let { left, top, width, height } = rect;
    left = Math.max(0, Math.min(left, iw - 1));
    top = Math.max(0, Math.min(top, ih - 1));
    width = Math.max(1, Math.min(width, iw - left));
    height = Math.max(1, Math.min(height, ih - top));
    const stroke = Math.max(2, Math.round(Math.min(iw, ih) / 400));
    const svg = `<svg width="${iw}" height="${ih}" xmlns="http://www.w3.org/2000/svg"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="none" stroke="rgb(255,0,0)" stroke-width="${stroke}"/></svg>`;
    return sharp(jpegBuffer).composite([{ input: Buffer.from(svg), blend: "over" }]).jpeg({ quality: 80 }).toBuffer();
  } catch (err) {
    logger.warn({ err: String(err) }, "drawRedBoundingBoxOnJpeg: failed, using original JPEG");
    return jpegBuffer;
  }
}

// Zoom guardrails.
const CONTEXT_PAD = 0.6;   // grow the crop by 60% of the region on each side
const MIN_CROP_FRAC = 0.22; // never crop tighter than this fraction of the image
const NO_ZOOM_FRAC = 0.7;  // region already covers most of the shot → don't crop
const TARGET_MIN_W = 640;  // upscale small crops to at least this wide, for legibility

/**
 * Best-effort rich evidence image. Tries zoom+box+caption, then falls back to a
 * boxed full shot, then the original — never throws.
 */
export async function renderIssueArtifact(
  jpegBuffer: Buffer,
  input: { region?: BugRegion; caption?: IssueCaption },
): Promise<Buffer> {
  const { region, caption } = input;
  try {
    const meta = await sharp(jpegBuffer).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw < 4 || ih < 4) return jpegBuffer;

    const rect = region ? regionToPixelRect(region, iw, ih) : null;

    // No usable region: caption the full shot if we have text, else return as-is.
    if (!rect) {
      if (caption) return await captionOnly(jpegBuffer, iw, caption);
      return jpegBuffer;
    }

    const regionFrac = (rect.width * rect.height) / (iw * ih);

    // Region already dominates the frame → box the full shot, add caption.
    if (regionFrac >= NO_ZOOM_FRAC) {
      const boxed = await drawRedBoundingBoxOnJpeg(jpegBuffer, region!);
      return caption ? await captionOnly(boxed, iw, caption) : boxed;
    }

    // Compute a padded crop around the region, clamped to the image and to a
    // minimum size so we don't zoom into an illegibly tiny area.
    const padX = rect.width * CONTEXT_PAD;
    const padY = rect.height * CONTEXT_PAD;
    let cropW = Math.max(rect.width + padX * 2, iw * MIN_CROP_FRAC);
    let cropH = Math.max(rect.height + padY * 2, ih * MIN_CROP_FRAC);
    cropW = Math.min(cropW, iw);
    cropH = Math.min(cropH, ih);
    // Center the crop on the region, then clamp inside the image.
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let cropL = Math.round(Math.max(0, Math.min(cx - cropW / 2, iw - cropW)));
    let cropT = Math.round(Math.max(0, Math.min(cy - cropH / 2, ih - cropH)));
    cropW = Math.round(cropW);
    cropH = Math.round(cropH);

    // Box coordinates relative to the crop.
    const boxL = rect.left - cropL;
    const boxT = rect.top - cropT;

    // Optional upscale so a small crop stays legible.
    const scale = cropW < TARGET_MIN_W ? Math.min(3, TARGET_MIN_W / cropW) : 1;
    const outW = Math.round(cropW * scale);
    const outH = Math.round(cropH * scale);

    const stroke = Math.max(3, Math.round(Math.min(outW, outH) / 120));
    const boxSvg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg"><rect x="${Math.round(boxL * scale)}" y="${Math.round(boxT * scale)}" width="${Math.round(rect.width * scale)}" height="${Math.round(rect.height * scale)}" fill="none" stroke="rgb(255,0,0)" stroke-width="${stroke}"/></svg>`;

    let img = sharp(jpegBuffer)
      .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
      .resize(outW, outH)
      .composite([{ input: Buffer.from(boxSvg), blend: "over" }]);

    let composed = await img.jpeg({ quality: 85 }).toBuffer();

    // Stack the caption bar under the zoomed crop.
    if (caption) {
      const bar = captionBar(caption, outW);
      if (bar) {
        composed = await sharp({
          create: { width: outW, height: outH + bar.height, channels: 3, background: "#18181b" },
        })
          .composite([
            { input: composed, top: 0, left: 0 },
            { input: Buffer.from(bar.svg), top: outH, left: 0 },
          ])
          .jpeg({ quality: 85 })
          .toBuffer();
      }
    }
    return composed;
  } catch (err) {
    logger.warn({ err: String(err) }, "renderIssueArtifact: zoom path failed, falling back");
    // Fallback rung: boxed full shot, else the original.
    if (region) return await drawRedBoundingBoxOnJpeg(jpegBuffer, region).catch(() => jpegBuffer);
    return jpegBuffer;
  }
}

/** Append a caption bar to the bottom of an image at its native width. */
async function captionOnly(jpegBuffer: Buffer, width: number, caption: IssueCaption): Promise<Buffer> {
  try {
    const bar = captionBar(caption, width);
    if (!bar) return jpegBuffer;
    const meta = await sharp(jpegBuffer).metadata();
    const h = meta.height ?? 0;
    if (!h) return jpegBuffer;
    return sharp({ create: { width, height: h + bar.height, channels: 3, background: "#18181b" } })
      .composite([
        { input: await sharp(jpegBuffer).jpeg().toBuffer(), top: 0, left: 0 },
        { input: Buffer.from(bar.svg), top: h, left: 0 },
      ])
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return jpegBuffer;
  }
}
