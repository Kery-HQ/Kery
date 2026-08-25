/**
 * Turn a bug's raw screenshot into the clearest possible evidence image.
 *
 * The best version zooms into the affected area (so the reader isn't hunting a
 * small box on a full-page shot), draws the box, and stamps a short caption
 * card underneath. Everything is best-effort with a strict fallback chain, so a
 * bug always gets *an* image:
 *
 *   best      zoomed crop + box + caption card
 *   fallback  box on the full screenshot
 *   fallback  the plain screenshot, untouched
 *
 * The in-image caption is deliberately a *headline only*. Long prose gets cut
 * off inside a fixed-width image and the reader has to go find the full text
 * anyway, so the surfaces that show these images (PR comment, run detail, issue
 * detail) print the full expectation/outcome next to the picture and the
 * picture carries a label you can read at a glance.
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
  /** What it actually did, or what confirmed the expected behavior for pass artifacts. */
  found?: string;
};

export type IssueArtifactVariant = "issue" | "pass";

/** Frame drawn around the whole artifact, in the caption card's colour. */
const BORDER = 5;

/**
 * Typeface for the caption card. Kery's UI is set in Outfit, which isn't
 * installed in the container that renders these, so we ask for the closest
 * neutral grotesques that are — Liberation Sans first (compact, even colour,
 * fits more per line than the fontconfig default of DejaVu Sans).
 */
const FONT = "Liberation Sans,Helvetica Neue,Helvetica,Arial,DejaVu Sans,sans-serif";

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

/** Collapse whitespace and drop a trailing full stop — headlines aren't sentences. */
function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.,;:]$/, "");
}

/** Greedy word-wrap to a character budget per line, capped at maxLines. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = tidy(text).split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= perLine) cur += " " + w;
    else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

/** Cut to a word boundary with an ellipsis, so a line never ends mid-word. */
function clamp(text: string, max: number): string {
  const clean = tidy(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[.,;:]$/, "") + "…";
}

/**
 * Outcome palette. The caption card — and the frame around the artifact, which
 * is the same colour — is green for verified behaviour and black for anything
 * that needs a look. Severity lives in the bounding box and the callout tag
 * (red for high/critical, yellow otherwise) rather than in a coloured card:
 * a black card keeps the caption readable and lets the annotation on the
 * screenshot be the thing that catches the eye.
 */
type Palette = {
  /** Caption card background + the frame around the whole image. */
  card: string;
  /** Bounding box stroke and callout tag fill. */
  box: string;
  /** Callout tag text, on `box`. */
  tagFg: string;
  /** Headline text on the card. */
  text: string;
  /** Small uppercase status label on the card. */
  label: string;
};

const PASS: Palette = { card: "#166534", box: "#22c55e", tagFg: "#052e16", text: "#ffffff", label: "#bbf7d0" };
const ERROR: Palette = { card: "#0c0c0d", box: "#ef4444", tagFg: "#ffffff", text: "#ffffff", label: "#fca5a5" };
const WARN: Palette = { card: "#0c0c0d", box: "#facc15", tagFg: "#111111", text: "#ffffff", label: "#fde047" };

function isSevere(severity?: string): boolean {
  const s = (severity ?? "").toLowerCase();
  return s === "high" || s === "critical";
}

function palette(severity?: string, variant: IssueArtifactVariant = "issue"): Palette {
  if (variant === "pass") return PASS;
  return isSevere(severity) ? ERROR : WARN;
}

/** Small uppercase status line on the caption card. */
function statusLabel(severity: string | undefined, variant: IssueArtifactVariant): string {
  if (variant === "pass") return "VERIFIED";
  const s = (severity ?? "").trim();
  return s ? `ISSUE · ${s.toUpperCase()}` : "ISSUE";
}

/** The one word stamped on the screenshot itself, at the box. */
function calloutTag(severity: string | undefined, variant: IssueArtifactVariant): string {
  if (variant === "pass") return "VERIFIED";
  return isSevere(severity) ? "BUG" : "ISSUE";
}

/**
 * The short headline for the caption card. Prefers the defect's own name, then
 * the outcome, then the expectation — and hard-clamps it, because the full text
 * belongs next to the image, not inside it.
 */
function headlineFor(caption: IssueCaption, budget: number): string {
  const source = [caption.headline, caption.found, caption.expected]
    .map((t) => (typeof t === "string" ? tidy(t) : ""))
    .find((t) => t.length > 0);
  return source ? clamp(source, budget) : "";
}

/**
 * Caption card: an annotation, never part of the app under test. A tracked
 * uppercase status line over a bold headline — two lines at most, so it always
 * fits and never trails off mid-sentence.
 */
function captionCard(
  caption: IssueCaption,
  width: number,
  pal: Palette,
  severity: string | undefined,
  variant: IssueArtifactVariant,
): { svg: string; height: number } | null {
  const padX = BORDER + Math.max(12, Math.round(width * 0.022));
  const padY = Math.max(12, Math.round(width * 0.018));
  // Sized as a fraction of the image so the caption keeps the same weight
  // whether the artifact is a tight crop or a full-page shot scaled down.
  const headFs = Math.max(15, Math.round(width / 34));
  const labelFs = Math.max(10, Math.round(headFs * 0.6));
  const lineH = Math.round(headFs * 1.32);
  const perLine = Math.max(20, Math.floor((width - padX * 2) / (headFs * 0.53)));

  const headline = headlineFor(caption, perLine * 2 - 2);
  if (!headline) return null;
  const lines = wrap(headline, perLine, 2);

  const labelY = padY + labelFs;
  const els: string[] = [
    `<text x="${padX}" y="${labelY}" font-family="${FONT}" font-size="${labelFs}" font-weight="700" letter-spacing="${(labelFs * 0.14).toFixed(2)}" fill="${pal.label}">${esc(statusLabel(severity, variant))}</text>`,
  ];
  let y = labelY + Math.round(headFs * 1.35);
  for (const line of lines) {
    els.push(`<text x="${padX}" y="${y}" font-family="${FONT}" font-size="${headFs}" font-weight="700" fill="${pal.text}">${esc(line)}</text>`);
    y += lineH;
  }
  const height = y - lineH + Math.round(headFs * 0.42) + padY;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="${pal.card}"/>${els.join("")}</svg>`;
  return { svg, height };
}

/**
 * A compact tag anchored to the box, flagging the finding right where it is.
 * Placed ABOVE the box by preference; if there's no room above, placed just
 * BELOW it — never inside, which would cover the very content the box points at.
 */
function calloutPill(label: string, boxX: number, boxY: number, boxBottom: number, outW: number, outH: number, fontSize: number, pal: Palette): string {
  const fs = Math.max(12, Math.round(fontSize * 0.9));
  const padX = Math.round(fs * 0.7);
  const padY = Math.round(fs * 0.42);
  const pillW = Math.min(outW - 4, Math.round(label.length * fs * 0.68) + padX * 2);
  const pillH = fs + padY * 2;
  const gap = Math.round(fs * 0.4);
  let px = boxX;
  if (px + pillW > outW - 2) px = Math.max(2, outW - 2 - pillW);
  const above = boxY - pillH - gap;
  const below = boxBottom + gap;
  // Above if it fits; else below if it fits; else clamp to the top edge — but
  // never overlay the boxed content.
  const py = above >= 2 ? above : (below + pillH <= outH - 2 ? below : 2);
  return `<rect x="${px}" y="${py}" width="${pillW}" height="${pillH}" rx="${Math.round(pillH / 4)}" fill="${pal.box}"/>` +
    `<text x="${px + padX}" y="${py + padY + fs - Math.round(fs * 0.2)}" font-family="${FONT}" font-size="${fs}" font-weight="700" letter-spacing="${(fs * 0.1).toFixed(2)}" fill="${pal.tagFg}">${esc(label)}</text>`;
}

/**
 * Frame the annotated shot and stack the caption card under it. The frame is
 * the card's colour, so the picture reads as one card rather than a screenshot
 * with a strip bolted on.
 */
async function frame(
  inner: Buffer,
  innerW: number,
  innerH: number,
  pal: Palette,
  card: { svg: string; height: number } | null,
): Promise<Buffer> {
  const width = innerW + BORDER * 2;
  const height = BORDER + innerH + (card ? card.height : BORDER);
  const layers: sharp.OverlayOptions[] = [{ input: inner, top: BORDER, left: BORDER }];
  if (card) layers.push({ input: Buffer.from(card.svg), top: BORDER + innerH, left: 0 });
  return sharp({ create: { width, height, channels: 3, background: pal.card } })
    .composite(layers)
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function drawBoundingBoxOnJpeg(jpegBuffer: Buffer, region: BugRegion, pal: Palette): Promise<Buffer> {
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
    const svg = `<svg width="${iw}" height="${ih}" xmlns="http://www.w3.org/2000/svg"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="none" stroke="${pal.box}" stroke-width="${stroke}"/></svg>`;
    return sharp(jpegBuffer).composite([{ input: Buffer.from(svg), blend: "over" }]).jpeg({ quality: 80 }).toBuffer();
  } catch (err) {
    logger.warn({ err: String(err) }, "drawBoundingBoxOnJpeg: failed, using original JPEG");
    return jpegBuffer;
  }
}

/** Legacy: severity-coloured stroke rect on the full JPEG. Kept as a fallback rung. */
export async function drawRedBoundingBoxOnJpeg(jpegBuffer: Buffer, region: BugRegion): Promise<Buffer> {
  return drawBoundingBoxOnJpeg(jpegBuffer, region, palette("high"));
}

// Zoom guardrails.
const CONTEXT_PAD = 0.6;   // grow the crop by 60% of the region on each side
const MIN_CROP_FRAC = 0.22; // never crop tighter than this fraction of the image
const NO_ZOOM_FRAC = 0.7;  // region already covers most of the shot → don't crop
const TARGET_MIN_W = 800;  // upscale small crops to at least this wide, for legibility (DPR-2 sources have the pixels for it)

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
  const pal = palette(severity, variant);
  try {
    const meta = await sharp(jpegBuffer).metadata();
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (iw < 4 || ih < 4) return jpegBuffer;

    const rect = region ? regionToPixelRect(region, iw, ih) : null;

    // No usable region: caption the full shot if we have text, else return as-is.
    if (!rect) {
      if (caption) return await captionOnly(jpegBuffer, iw, caption, pal, severity, variant);
      return jpegBuffer;
    }

    const regionFrac = (rect.width * rect.height) / (iw * ih);

    // Region already dominates the frame → box the full shot, add caption.
    if (regionFrac >= NO_ZOOM_FRAC) {
      const boxed = await drawBoundingBoxOnJpeg(jpegBuffer, region!, pal);
      return caption
        ? await captionOnly(boxed, iw, caption, pal, severity, variant)
        : await frame(boxed, iw, ih, pal, null);
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
    const cropL = Math.round(Math.max(0, Math.min(cx - cropW / 2, iw - cropW)));
    const cropT = Math.round(Math.max(0, Math.min(cy - cropH / 2, ih - cropH)));
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
    // One short word at the box; the headline sits on the card below it.
    const pill = calloutPill(calloutTag(severity, variant), bx, by, by + Math.round(rect.height * scale), outW, outH, pillFs, pal);
    const boxSvg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg"><rect x="${bx}" y="${by}" width="${bw}" height="${Math.round(rect.height * scale)}" fill="none" stroke="${pal.box}" stroke-width="${stroke}"/>${pill}</svg>`;

    const composed = await sharp(jpegBuffer)
      .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
      .resize(outW, outH)
      .composite([{ input: Buffer.from(boxSvg), blend: "over" }])
      .jpeg({ quality: 85 })
      .toBuffer();

    const card = caption ? captionCard(caption, outW + BORDER * 2, pal, severity, variant) : null;
    return await frame(composed, outW, outH, pal, card);
  } catch (err) {
    logger.warn({ err: String(err) }, "renderIssueArtifact: zoom path failed, falling back");
    // Fallback rung: boxed full shot, else the original.
    if (region) return await drawBoundingBoxOnJpeg(jpegBuffer, region, pal).catch(() => jpegBuffer);
    return jpegBuffer;
  }
}

/** Frame an image at its native width and stack the caption card beneath it. */
async function captionOnly(
  jpegBuffer: Buffer,
  width: number,
  caption: IssueCaption,
  pal: Palette,
  severity: string | undefined,
  variant: IssueArtifactVariant,
): Promise<Buffer> {
  try {
    const meta = await sharp(jpegBuffer).metadata();
    const h = meta.height ?? 0;
    if (!h) return jpegBuffer;
    const card = captionCard(caption, width + BORDER * 2, pal, severity, variant);
    return await frame(await sharp(jpegBuffer).jpeg().toBuffer(), width, h, pal, card);
  } catch {
    return jpegBuffer;
  }
}
