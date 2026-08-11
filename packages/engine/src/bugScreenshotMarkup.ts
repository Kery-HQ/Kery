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

/** Kery mango logo (48px), embedded so the engine stays self-contained. */
const KERY_LOGO = "data:image/png;base64,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";

export type BugRegion = { x: number; y: number; w: number; h: number };

export type IssueCaption = {
  /** One-line title of the defect (e.g. the bug name). */
  headline?: string;
  /** What the app should have done. */
  expected?: string;
  /** What it actually did, or what confirmed the expected behavior for pass artifacts. */
  found?: string;
};

export type IssueArtifactVariant = "issue" | "pass";

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

const ERR_RED = "#dc2626";

/**
 * Banner colour follows the artifact outcome: pass evidence is green; issue
 * evidence uses red for high/critical and yellow for medium/low. The same
 * accent drives the box stroke and the callout pill so the annotation reads as
 * one outcome.
 */
type BannerStyle = { accent: string; fg: string };
function bannerStyle(severity?: string, variant: IssueArtifactVariant = "issue"): BannerStyle {
  if (variant === "pass") return { accent: "#16a34a", fg: "#ffffff" };
  const s = (severity ?? "").toLowerCase();
  if (s === "high" || s === "critical") return { accent: ERR_RED, fg: "#ffffff" };
  return { accent: "#facc15", fg: "#111111" };
}

/** Kery mango logo, icon only, right-aligned at a baseline. */
function keryBrand(width: number, baseline: number, fs: number): string {
  const mark = Math.round(fs * 1.6);
  const x = width - Math.round(fs * 0.9) - mark;
  const y = baseline - mark + Math.round(fs * 0.28);
  return `<image x="${x}" y="${y}" width="${mark}" height="${mark}" href="${KERY_LOGO}" preserveAspectRatio="xMidYMid meet"/>`;
}

/**
 * Caption band: an annotation, never part of the app under test. Colour keyed to
 * outcome, a bold headline then Expected / Found or Expected / Confirmed, and a
 * Kery wordmark in the bottom-right corner.
 */
function captionBar(
  caption: IssueCaption,
  width: number,
  style: BannerStyle,
  variant: IssueArtifactVariant,
): { svg: string; height: number } | null {
  const rows: Array<{ label: string; text: string; strong: boolean }> = [];
  if (caption.headline?.trim()) rows.push({ label: "", text: caption.headline.trim(), strong: true });
  if (caption.expected?.trim()) rows.push({ label: "Expected", text: caption.expected.trim(), strong: false });
  if (caption.found?.trim()) rows.push({ label: variant === "pass" ? "Confirmed" : "Found", text: caption.found.trim(), strong: false });
  if (rows.length === 0) return null;

  const pad = Math.round(width * 0.022);
  const fontSize = Math.max(13, Math.round(width / 45));
  const lineH = Math.round(fontSize * 1.4);
  const perLine = Math.max(24, Math.floor((width - pad * 2) / (fontSize * 0.56)));

  const soloHeadline = rows.length === 1 && !rows[0].label;
  const lineEls: string[] = [];
  let y = pad + fontSize;
  for (const row of rows) {
    const wrapped = wrap((row.label ? `${row.label}: ` : "") + row.text, perLine, soloHeadline ? 3 : 2);
    for (const ln of wrapped) {
      lineEls.push(`<text x="${pad}" y="${y}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${fontSize}" font-weight="${row.strong ? 700 : 400}" fill="${style.fg}">${esc(ln)}</text>`);
      y += lineH;
    }
  }
  // Reserve a footer row for the Kery wordmark so it never collides with copy.
  const brandFs = Math.max(11, Math.round(fontSize * 0.82));
  const brandRowH = brandFs + Math.round(pad * 0.9);
  const contentH = y - fontSize + Math.round(pad * 0.4);
  const height = contentH + brandRowH;
  const brand = keryBrand(width, height - Math.round(pad * 0.7), brandFs);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="${style.accent}"/>${lineEls.join("")}${brand}</svg>`;
  return { svg, height };
}

/**
 * A compact pill anchored to the box, coloured by severity, flagging the error
 * right where it is. Placed ABOVE the box by preference; if there's no room
 * above, placed just BELOW it — never inside, which would cover the very content
 * the box is pointing at.
 */
function calloutPill(label: string, boxX: number, boxY: number, boxBottom: number, outW: number, outH: number, fontSize: number, style: BannerStyle): string {
  const text = label.length > 46 ? label.slice(0, 45).replace(/\s\S*$/, "") + "…" : label;
  const fs = Math.max(13, Math.round(fontSize * 0.9));
  const padX = Math.round(fs * 0.6);
  const padY = Math.round(fs * 0.4);
  const pillW = Math.min(outW - 4, Math.round(text.length * fs * 0.56) + padX * 2);
  const pillH = fs + padY * 2;
  const gap = Math.round(fs * 0.4);
  let px = boxX;
  if (px + pillW > outW - 2) px = Math.max(2, outW - 2 - pillW);
  const above = boxY - pillH - gap;
  const below = boxBottom + gap;
  // Above if it fits; else below if it fits; else clamp above the top edge —
  // but never overlay the boxed content.
  let py = above >= 2 ? above : (below + pillH <= outH - 2 ? below : 2);
  return `<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="${Math.round(pillH / 5)}" fill="${style.accent}"/>` +
    `<text x="${px + padX}" y="${py + padY + fs - Math.round(fs * 0.18)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="${fs}" font-weight="700" fill="${style.fg}">${esc(text)}</text>`;
}

async function drawBoundingBoxOnJpeg(jpegBuffer: Buffer, region: BugRegion, style: BannerStyle): Promise<Buffer> {
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
    const svg = `<svg width="${iw}" height="${ih}" xmlns="http://www.w3.org/2000/svg"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="none" stroke="${style.accent}" stroke-width="${stroke}"/></svg>`;
    return sharp(jpegBuffer).composite([{ input: Buffer.from(svg), blend: "over" }]).jpeg({ quality: 80 }).toBuffer();
  } catch (err) {
    logger.warn({ err: String(err) }, "drawBoundingBoxOnJpeg: failed, using original JPEG");
    return jpegBuffer;
  }
}

/** Legacy: red stroke rect on the full JPEG. Kept as a fallback rung. */
export async function drawRedBoundingBoxOnJpeg(jpegBuffer: Buffer, region: BugRegion): Promise<Buffer> {
  return drawBoundingBoxOnJpeg(jpegBuffer, region, bannerStyle("high"));
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
  input: { region?: BugRegion; caption?: IssueCaption; severity?: string; variant?: IssueArtifactVariant },
): Promise<Buffer> {
  const { region, caption, severity } = input;
  const variant = input.variant ?? "issue";
  const style = bannerStyle(severity, variant);
  try {
    const meta = await sharp(jpegBuffer).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw < 4 || ih < 4) return jpegBuffer;

    const rect = region ? regionToPixelRect(region, iw, ih) : null;

    // No usable region: caption the full shot if we have text, else return as-is.
    if (!rect) {
      if (caption) return await captionOnly(jpegBuffer, iw, caption, style, variant);
      return jpegBuffer;
    }

    const regionFrac = (rect.width * rect.height) / (iw * ih);

    // Region already dominates the frame → box the full shot, add caption.
    if (regionFrac >= NO_ZOOM_FRAC) {
      const boxed = await drawBoundingBoxOnJpeg(jpegBuffer, region!, style);
      return caption ? await captionOnly(boxed, iw, caption, style, variant) : boxed;
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
    // The pill flags the evidence right at the box; short label from the caption.
    const pillLabel = variant === "pass" ? "Verified" : (caption?.headline?.trim() || caption?.found?.trim() || "");
    const pill = pillLabel ? calloutPill(pillLabel, bx, by, by + Math.round(rect.height * scale), outW, outH, pillFs, style) : "";
    const boxSvg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg"><rect x="${bx}" y="${by}" width="${bw}" height="${Math.round(rect.height * scale)}" fill="none" stroke="${style.accent}" stroke-width="${stroke}"/>${pill}</svg>`;

    let img = sharp(jpegBuffer)
      .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
      .resize(outW, outH)
      .composite([{ input: Buffer.from(boxSvg), blend: "over" }]);

    let composed = await img.jpeg({ quality: 85 }).toBuffer();

    // Stack the caption bar under the zoomed crop.
    if (caption) {
      const bar = captionBar(caption, outW, style, variant);
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
    if (region) return await drawBoundingBoxOnJpeg(jpegBuffer, region, style).catch(() => jpegBuffer);
    return jpegBuffer;
  }
}

/** Append a caption bar to the bottom of an image at its native width. */
async function captionOnly(
  jpegBuffer: Buffer,
  width: number,
  caption: IssueCaption,
  style: BannerStyle,
  variant: IssueArtifactVariant,
): Promise<Buffer> {
  try {
    const bar = captionBar(caption, width, style, variant);
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
