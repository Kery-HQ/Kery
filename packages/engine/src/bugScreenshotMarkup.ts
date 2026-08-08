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
const ERR_RED = "#dc2626";

/**
 * Error banner: white on red so it reads as an annotation, never as part of the
 * app under test. A bold headline, then Expected / Found. Rendered as a solid
 * red band the width of the image.
 */
function captionBar(caption: IssueCaption, width: number): { svg: string; height: number } | null {
  const rows: Array<{ label: string; text: string; strong: boolean }> = [];
  if (caption.headline?.trim()) rows.push({ label: "", text: caption.headline.trim(), strong: true });
  if (caption.expected?.trim()) rows.push({ label: "Expected", text: caption.expected.trim(), strong: false });
  if (caption.found?.trim()) rows.push({ label: "Found", text: caption.found.trim(), strong: false });
  if (rows.length === 0) return null;

  const pad = Math.round(width * 0.022);
  const fontSize = Math.max(13, Math.round(width / 45));
  const lineH = Math.round(fontSize * 1.4);
  const perLine = Math.max(24, Math.floor((width - pad * 2) / (fontSize * 0.56)));

  const soloHeadline = rows.length === 1 && !rows[0].label;
  const lineEls: string[] = [];
  let y = pad + fontSize;
  for (const row of rows) {
    // Expected/Found: white bold label + regular white text. On red, white reads
    // cleanly; green/red text would clash, so the label carries the meaning.
    const wrapped = wrap((row.label ? `${row.label}: ` : "") + row.text, perLine, soloHeadline ? 3 : 2);
    for (const ln of wrapped) {
      lineEls.push(`<text x="${pad}" y="${y}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${fontSize}" font-weight="${row.strong ? 700 : 400}" fill="#ffffff">${esc(ln)}</text>`);
      y += lineH;
    }
  }
  const height = y - fontSize + pad;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="${ERR_RED}"/>${lineEls.join("")}</svg>`;
  return { svg, height };
}

/**
 * A compact white-on-red pill anchored to the red box, so the error is flagged
 * exactly where it is — like the reference "still present after reload" badge.
 * Placed above the box, or just inside its top when there's no room above.
 * Returns SVG fragments to fold into the overlay (coordinates are already scaled).
 */
function calloutPill(label: string, boxX: number, boxY: number, boxW: number, outW: number, fontSize: number): string {
  const text = label.length > 46 ? label.slice(0, 45).replace(/\s\S*$/, "") + "…" : label;
  const fs = Math.max(13, Math.round(fontSize * 0.9));
  const padX = Math.round(fs * 0.6);
  const padY = Math.round(fs * 0.4);
  const pillW = Math.min(outW - 4, Math.round(text.length * fs * 0.56) + padX * 2);
  const pillH = fs + padY * 2;
  let px = boxX;
  if (px + pillW > outW - 2) px = Math.max(2, outW - 2 - pillW);
  let py = boxY - pillH - Math.round(fs * 0.4);
  if (py < 2) py = boxY + 2; // no room above → tuck inside the box top
  return `<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="${Math.round(pillH / 5)}" fill="${ERR_RED}"/>` +
    `<text x="${px + padX}" y="${py + padY + fs - Math.round(fs * 0.18)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${fs}" font-weight="700" fill="#ffffff">${esc(text)}</text>`;
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
    const bx = Math.round(boxL * scale);
    const by = Math.round(boxT * scale);
    const bw = Math.round(rect.width * scale);
    const pillFs = Math.max(13, Math.round(outW / 45));
    // The pill flags the error right at the box; short label from the caption.
    const pillLabel = caption?.headline?.trim() || caption?.found?.trim() || "";
    const pill = pillLabel ? calloutPill(pillLabel, bx, by, bw, outW, pillFs) : "";
    const boxSvg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg"><rect x="${bx}" y="${by}" width="${bw}" height="${Math.round(rect.height * scale)}" fill="none" stroke="${ERR_RED}" stroke-width="${stroke}"/>${pill}</svg>`;

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
