/**
 * Screenshot fidelity knobs.
 *
 * Evidence images (issue shots, verification check shots, zoom crops) are only
 * as sharp as the source capture. At deviceScaleFactor 1 a 1920×1080 capture
 * has too few pixels for the zoom-crop renderer, which upscales small regions
 * — the result reads as blurry. DPR 2 quadruples the pixels behind every crop
 * while CSS layout (and the recorded video size) stays identical.
 *
 * Vision-model cost is unaffected: providers rescale inputs to a fixed tile
 * budget, so a 2x capture tokenizes the same as a 1x one. The costs that do
 * grow are artifact storage and per-request payload size — the LLM-bound
 * snapshot is downscaled back to LLM_IMAGE_MAX_WIDTH to keep uploads fast.
 */

export function screenshotDpr(): number {
  const parsed = Number(process.env.KERY_SCREENSHOT_DPR || 2);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(3, Math.max(1, parsed));
}

/** Max width for screenshots embedded in LLM prompts (CSS-pixel scale). */
export const LLM_IMAGE_MAX_WIDTH = 1920;
