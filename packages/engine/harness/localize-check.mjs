/**
 * A/B for the bug localizer: reproduce the three navigator-bug states from the
 * clean-slate gift-note run (the ones that got a FULL-FRAME shot because they
 * carry no region), run the real localizer over each full screenshot, and
 * render old (no region → full/boxed) vs new (localized → zoomed) artifacts.
 *
 * Detection can't change here — this only checks image quality + fallback.
 * Requires OPENAI_API_KEY (+ KERY_REVIEW_MODEL). Writes to /tmp/localize/.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { initEngineConfig, localizeBugRegions, renderIssueArtifact } = await import(
  path.join(here, "../dist/index.js")
);

initEngineConfig({
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  anthropicApiKey: "",
  geminiApiKey: "",
  agentModel: process.env.KERY_AGENT_MODEL || "terra",
  auxiliaryModel: process.env.KERY_AUXILIARY_MODEL || "luna",
  reviewAgentModel: process.env.KERY_REVIEW_MODEL || "terra",
  stagehandModel: process.env.KERY_STAGEHAND_MODEL || "luna",
  stagehandEnabled: false,
  runTimeoutMinutes: 12,
  llmTimeoutMs: 120_000,
  reviewTimeoutMs: 120_000,
});

const OUT = "/tmp/localize";
mkdirSync(OUT, { recursive: true });

// A faithful static replica of the gift-note page in each defect state, so the
// full screenshot has the same "small defect on a mostly-fine page" shape the
// navigator captures. The defect sits well inside the frame (not full-bleed),
// which is exactly the case the localizer must zoom.
function page(bodyInner) {
  return `<!doctype html><html><head><meta charset="utf8"><style>
  *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,Arial}
  body{margin:0;background:#fff;color:#18181b}
  .wrap{max-width:672px;margin:0 auto;padding:40px 16px}
  header{display:flex;justify-content:space-between;align-items:center}
  .brand{font-weight:700;font-size:18px}.shop{color:#71717a;font-size:14px}
  h1{margin:40px 0 8px;font-size:30px}.sub{color:#71717a;font-size:14px;margin:0}
  .card{margin-top:32px;border:1px solid #e4e4e7;border-radius:12px;padding:20px}
  label{font-size:14px;font-weight:500}
  textarea{margin-top:8px;width:100%;border:1px solid #d4d4d8;border-radius:8px;padding:8px 12px;font-size:14px;min-height:72px}
  .count{margin-top:4px;font-size:12px;color:#71717a}
  .plabel{margin-top:20px;font-size:14px;font-weight:500}
  .preview{margin-top:8px;min-height:80px;border:1px dashed #d4d4d8;background:#fafafa;border-radius:8px;padding:16px;font-size:14px}
  button{margin-top:20px;background:#18181b;color:#fff;border:0;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:500}
  .saved{margin-top:12px;color:#15803d;font-size:14px}
  </style></head><body><div class="wrap">
  <header><span class="brand">purchasify</span><span class="shop">Shop</span></header>
  <h1>Gift note</h1><p class="sub">Write a note for the recipient and preview the printed card.</p>
  <div class="card">${bodyInner}</div>
  </div></body></html>`;
}

const CASES = [
  {
    id: "counter",
    severity: "medium",
    html: page(`<label>Your note</label>
      <textarea>ABCD</textarea>
      <div class="count">3 of 200 characters</div>
      <div class="plabel">Card preview</div>
      <div class="preview">ABCD</div>
      <button>Save note</button>`),
    caption: {
      headline: "Character counter is off by one",
      expected: "Typing 'ABCD' (4 chars) should read '4 of 200 characters'",
      found: "It reads '3 of 200 characters' — one fewer than typed",
    },
    text: "Character counter is off by one for typed notes: 'ABCD' shows '3 of 200 characters' instead of 4.",
  },
  {
    id: "rawhtml",
    severity: "medium",
    html: page(`<label>Your note</label>
      <textarea>Hello &lt;b&gt;world&lt;/b&gt;</textarea>
      <div class="count">16 of 200 characters</div>
      <div class="plabel">Card preview</div>
      <div class="preview">Hello <b>world</b></div>
      <button>Save note</button>`),
    caption: {
      headline: "Card preview renders HTML instead of escaping it",
      expected: "The preview should show the literal text, angle brackets and all",
      found: "'<b>world</b>' renders as bold — raw HTML is interpreted",
    },
    text: "The live card preview renders HTML-like input instead of escaping it. 'Hello <b>world</b>' shows 'Hello world' bolded.",
  },
  {
    id: "saved",
    severity: "low",
    html: page(`<label>Your note</label>
      <textarea>Happy birthday!</textarea>
      <div class="count">14 of 200 characters</div>
      <div class="plabel">Card preview</div>
      <div class="preview">Happy birthday!</div>
      <button>Save note</button>
      <div class="saved">Your note has been saved to the order.</div>`),
    caption: {
      headline: "Save confirmation does not name the saved note",
      expected: "The confirmation should indicate which note was saved",
      found: "It only says 'Your note has been saved to the order.'",
    },
    text: "After clicking Save note, the confirmation is only 'Your note has been saved to the order.' — it does not say which note was saved.",
  },
];

const browser = await chromium.launch();
const results = [];
for (const c of CASES) {
  const p = await browser.newPage();
  await p.setViewportSize({ width: 1000, height: 720 });
  await p.setContent(c.html, { waitUntil: "networkidle" });
  await p.waitForTimeout(150);
  const shot = Buffer.from(await p.screenshot({ type: "jpeg", quality: 80 }));
  await p.close();

  // OLD: navigator bug, no region → current full/boxed behavior.
  const oldImg = await renderIssueArtifact(shot, { region: undefined, caption: c.caption, severity: c.severity });
  writeFileSync(path.join(OUT, `${c.id}-old.jpg`), oldImg);

  // NEW: run the real localizer over the same full screenshot, as a synthetic
  // navigator bug, then render with whatever region it found.
  const bug = { action: "bug", source: "navigator", severity: c.severity, reasoning: c.text, screenshotBase64: shot.toString("base64") };
  const { localized } = await localizeBugRegions([bug]);
  const region = bug.region;
  const newImg = await renderIssueArtifact(shot, { region, caption: c.caption, severity: c.severity });
  writeFileSync(path.join(OUT, `${c.id}-new.jpg`), newImg);

  results.push({ id: c.id, localized, region: region ? `${region.x},${region.y} ${region.w}x${region.h}` : "NONE (fallback → full)" });
  console.log(`${c.id}: localized=${localized} region=${results.at(-1).region}`);
}
await browser.close();
console.log("\nDone. Images in", OUT);
console.table(results);
