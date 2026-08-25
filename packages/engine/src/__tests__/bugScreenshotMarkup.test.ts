import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderIssueArtifact } from "../bugScreenshotMarkup.js";

async function solidJpeg(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 100 }).toBuffer();
}

async function imageInfo(buf: Buffer): Promise<{ width: number; height: number; pixels: Buffer }> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: data };
}

function hasApproxColor(
  pixels: Buffer,
  target: [number, number, number],
  tolerance = 36,
): boolean {
  for (let i = 0; i < pixels.length; i += 3) {
    const dr = Math.abs(pixels[i] - target[0]);
    const dg = Math.abs(pixels[i + 1] - target[1]);
    const db = Math.abs(pixels[i + 2] - target[2]);
    if (dr <= tolerance && dg <= tolerance && db <= tolerance) return true;
  }
  return false;
}

/** Colour of the frame, sampled a couple of pixels in from the top-left corner. */
async function framePixel(buf: Buffer): Promise<[number, number, number]> {
  const { data } = await sharp(buf).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}

const GREEN_BOX: [number, number, number] = [34, 197, 94];
const YELLOW_BOX: [number, number, number] = [250, 204, 21];
const RED_BOX: [number, number, number] = [239, 68, 68];
const GREEN_CARD: [number, number, number] = [22, 101, 52];
const BLACK_CARD: [number, number, number] = [12, 12, 13];

describe("renderIssueArtifact", () => {
  it("renders pass artifacts in green, framed in the card colour", async () => {
    const base = await solidJpeg(800, 500, "#ffffff");
    const out = await renderIssueArtifact(base, {
      variant: "pass",
      region: { x: 200, y: 180, w: 180, h: 140 },
      caption: {
        headline: "Saving a task",
        expected: "Saving a task shows it in the list.",
        found: "The new row is visible after save.",
      },
    });

    const info = await imageInfo(out);
    assert.ok(info.width > 0 && info.height > 0);
    assert.ok(hasApproxColor(info.pixels, GREEN_BOX), "pass accent should be present");
    assert.ok(hasApproxColor(info.pixels, GREEN_CARD), "pass caption card should be green");
    const frame = await framePixel(out);
    assert.ok(hasApproxColor(Buffer.from(frame), GREEN_CARD, 12), "frame should match the pass card");
  });

  it("puts warnings on a black card with a yellow box", async () => {
    const base = await solidJpeg(800, 500, "#ffffff");
    const out = await renderIssueArtifact(base, {
      severity: "medium",
      region: { x: 200, y: 180, w: 180, h: 140 },
      caption: { headline: "Quantity stepper allows a negative value" },
    });

    const info = await imageInfo(out);
    assert.ok(hasApproxColor(info.pixels, YELLOW_BOX), "warning box should be yellow");
    assert.ok(hasApproxColor(info.pixels, BLACK_CARD, 12), "warning caption card should be black");
    const frame = await framePixel(out);
    assert.ok(hasApproxColor(Buffer.from(frame), BLACK_CARD, 12), "frame should match the black card");
  });

  it("keeps red for high severity, still on a black card", async () => {
    const base = await solidJpeg(800, 500, "#ffffff");
    const out = await renderIssueArtifact(base, {
      severity: "critical",
      region: { x: 200, y: 180, w: 180, h: 140 },
      caption: { headline: "Checkout charges twice" },
    });

    const info = await imageInfo(out);
    assert.ok(hasApproxColor(info.pixels, RED_BOX), "critical box should be red");
    assert.ok(hasApproxColor(info.pixels, BLACK_CARD, 12), "critical caption card should be black");
  });

  it("uses the same no-region caption fallback for pass artifacts", async () => {
    const base = await solidJpeg(640, 360, "#ffffff");
    const out = await renderIssueArtifact(base, {
      variant: "pass",
      region: { x: 950, y: 100, w: 100, h: 100 },
      caption: {
        expected: "A success message appears.",
        found: "The success toast is visible.",
      },
    });

    const info = await imageInfo(out);
    assert.equal(info.width, 650, "an invalid region should keep the native width plus the frame");
    assert.ok(info.height > 370, "invalid regions should fall back to a captioned full shot");
    assert.ok(hasApproxColor(info.pixels, GREEN_CARD), "pass caption fallback should keep the pass card");
  });

  it("returns the untouched screenshot when there is nothing to say", async () => {
    const base = await solidJpeg(400, 300, "#ffffff");
    const out = await renderIssueArtifact(base, {});
    const info = await imageInfo(out);
    assert.equal(info.width, 400);
    assert.equal(info.height, 300);
  });
});
