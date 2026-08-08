import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { renderIssueArtifact } from "./dist/index.js";
const b = await chromium.launch(); const p = await b.newPage();
await p.setViewportSize({ width: 1000, height: 720 });
await p.goto("http://localhost:4400/tasks.html"); await p.waitForTimeout(300);
const shot = Buffer.from(await p.screenshot({ type: "jpeg", quality: 80 }));
const box = await p.$$eval(".row", rows => { const r = rows.find(x=>x.textContent.includes("Quarterly report")).getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; });
await b.close();
const region = { x: Math.round(box.x/1000*1000), y: Math.round(box.y/720*1000), w: Math.round(box.w/1000*1000), h: Math.round(box.h/720*1000) };
const cap = { headline: "Deleted task returns after reload", expected: "Deleting the task should remove it permanently", found: "The row reappears after reloading" };
writeFileSync("/tmp/fix-high.jpg", await renderIssueArtifact(shot, { region, caption: cap, severity: "high" }));
// Near-top region to force the pill BELOW the box (was hiding content before).
const topRegion = { x: 60, y: 5, w: 400, h: 60 };
writeFileSync("/tmp/fix-top.jpg", await renderIssueArtifact(shot, { region: topRegion, caption: { headline: "Header overlaps content", found: "The banner covers the first row" }, severity: "medium" }));
console.log("wrote /tmp/fix-high.jpg and /tmp/fix-top.jpg");
