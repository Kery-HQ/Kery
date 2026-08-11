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

describe("renderIssueArtifact", () => {
  it("renders pass artifacts with the green accent", async () => {
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
    assert.ok(hasApproxColor(info.pixels, [22, 163, 74]), "pass accent should be present");
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
    assert.equal(info.width, 640);
    assert.ok(info.height > 360, "invalid regions should fall back to a captioned full shot");
    assert.ok(hasApproxColor(info.pixels, [22, 163, 74]), "pass caption fallback should keep the pass accent");
  });
});
