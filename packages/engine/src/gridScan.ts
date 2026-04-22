/**
 * Grid overlay for coordinate-space visualization.
 *
 * Draws a labeled 0-1000 coordinate grid on a JPEG screenshot buffer using
 * sharp, so the LLM can read off precise x/y values for dragAndDrop and
 * other coordinate-based actions without needing multiple poke attempts.
 */
import sharp from "sharp";

const VIEWPORT_W = 1920;
const VIEWPORT_H = 1080;
/** Normalized units between grid lines (0-1000 scale). */
const GRID_STEP = 100;
const DIVISIONS = 1000 / GRID_STEP; // 10 intervals → 11 lines

/**
 * Overlays a labeled coordinate grid (0-1000 scale) onto a JPEG screenshot.
 * Major gridlines appear every 200 units; minor every 100 units.
 * Labels are rendered at the top and left edges so the agent can read the
 * exact normalized coordinate at any point on the page.
 */
export async function drawGridOnScreenshot(screenshot: Buffer): Promise<Buffer> {
  const W = VIEWPORT_W;
  const H = VIEWPORT_H;

  const parts: string[] = [];

  const addLine = (x1: number, y1: number, x2: number, y2: number, major: boolean) => {
    const w = major ? 1.5 : 0.8;
    const op = major ? 0.5 : 0.28;
    // Black shadow pass for visibility on light backgrounds
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="black" stroke-width="${w + 1}" stroke-opacity="${op * 0.6}"/>`);
    // White foreground pass for visibility on dark backgrounds
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="white" stroke-width="${w}" stroke-opacity="${op}"/>`);
  };

  const addLabel = (cx: number, cy: number, text: string) => {
    const w = text.length * 6 + 4;
    const h = 13;
    parts.push(`<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" fill="rgba(0,0,0,0.65)" rx="2"/>`);
    parts.push(`<text x="${cx}" y="${cy + 4}" font-family="monospace" font-size="10" fill="white" text-anchor="middle">${text}</text>`);
  };

  for (let i = 0; i <= DIVISIONS; i++) {
    const norm = i * GRID_STEP;
    const major = norm % 200 === 0;

    // Vertical line at normalized x = norm
    const px = Math.round((norm / 1000) * W);
    addLine(px, 0, px, H, major);
    addLabel(px, 10, String(norm));

    // Horizontal line at normalized y = norm
    const py = Math.round((norm / 1000) * H);
    addLine(0, py, W, py, major);
    if (norm > 0) addLabel(16, py, String(norm)); // skip 0 — already covered by vertical label
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">\n${parts.join("\n")}\n</svg>`;

  return sharp(screenshot)
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .jpeg({ quality: 75 })
    .toBuffer();
}
