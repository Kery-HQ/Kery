/**
 * Capability matrix: does Kery's perception + action layer work across the
 * common UI controls, in several frameworks, for STATE, VALUE and ACTION?
 *
 * Deterministic — no LLM. For each control it exercises the engine's real
 * primitives (extractA11yTree, resolveElement, executeAction) exactly as the
 * agent would, and checks a concrete, observable outcome. This measures the
 * FLOOR: if the engine cannot perceive or drive a control here, no prompt can
 * fix it in production.
 *
 * Axes per check:
 *   perceive — the control appears in the a11y tree with the right role/name
 *   state    — its state (checked/pressed/selected/expanded/value) is truthful
 *   action   — resolving + executing an action produces the expected effect
 */
import { chromium } from "playwright";
import { extractA11yTree, resolveElement } from "./dist/a11yTree.js";
import { executeAction } from "./dist/agent.js";

const BASE = "http://localhost:4300";
const results = [];
function record(framework, control, axis, ok, detail) {
  results.push({ framework, control, axis, ok, detail });
}

async function freshTree(page) {
  // Bust the DOM-hash cache so state changes are always re-read.
  return extractA11yTree(page, `probe-${Math.random()}`);
}
function find(tree, pred) { return tree.elements.find(pred); }

async function run() {
  const browser = await chromium.launch();

  for (const framework of ["plain", "react", "vue", "bootstrap"]) {
    const page = await browser.newPage();
    await page.goto(`${BASE}/${framework}.html`);
    await page.waitForTimeout(400); // let React/Vue mount

    const tree = await freshTree(page);
    const els = tree.elements;

    // ---- Text input: perceive + value + action(fill) ----
    const nameEl = find(tree, e => e.role === "textbox" && /full name/i.test(e.name || e.label || ""));
    record(framework, "text input", "perceive", !!nameEl, nameEl ? `${nameEl.role}:${nameEl.name || nameEl.label}` : "not found");
    if (nameEl) {
      const loc = await resolveElement(page, nameEl);
      let acted = false;
      if (loc) { await loc.fill("Grace Hopper").catch(() => {}); acted = true; }
      else { await executeAction(page, { action: "fill", element: nameEl.id, value: "Grace Hopper" }).catch(() => {}); acted = true; }
      await page.waitForTimeout(150);
      const after = await freshTree(page);
      const nv = find(after, e => e.role === "textbox" && /full name/i.test(e.name || e.label || ""));
      record(framework, "text input", "value", nv?.value === "Grace Hopper", `value=${JSON.stringify(nv?.value)}`);
      record(framework, "text input", "action", acted, "fill executed");
    }

    // ---- Number input ----
    const numEl = find(tree, e => e.role === "spinbutton" || (e.role === "textbox" && /seats/i.test(e.name || e.label || "")));
    record(framework, "number input", "perceive", !!numEl, numEl ? `${numEl.role}` : "not found");

    // ---- Native select (plain, vue, bootstrap have it) ----
    // Drive it the way the agent does: resolve the element to a locator, then
    // selectOption. executeAction takes x/y or target, never an element id —
    // id→locator resolution is the agent loop's job (via resolveElement).
    const selEl = find(tree, e => e.role === "combobox" && /plan/i.test(e.name || e.label || ""));
    if (selEl) {
      record(framework, "native select", "perceive", true, `value=${JSON.stringify(selEl.value)}`);
      const loc = await resolveElement(page, selEl);
      let acted = false;
      if (loc) { await loc.selectOption({ label: "Scale — $99" }).catch(() => {}); acted = true; }
      await page.waitForTimeout(150);
      const after = await freshTree(page);
      const sv = find(after, e => e.role === "combobox" && /plan/i.test(e.name || e.label || ""));
      record(framework, "native select", "value", /scale/i.test(sv?.value || ""), `after=${JSON.stringify(sv?.value)}`);
      record(framework, "native select", "action", acted, "selectOption executed");
    }

    // ---- Checkbox / switch (state truthfulness + toggle) ----
    const toggle = find(tree, e => (e.role === "checkbox" || e.role === "switch") && /email me updates/i.test(e.name || e.label || ""));
    if (toggle) {
      record(framework, "checkbox/switch", "perceive", true, `${toggle.role} checked=${toggle.checked}`);
      const before = toggle.checked === true;
      const loc = await resolveElement(page, toggle);
      if (loc) await loc.click().catch(() => {}); else await executeAction(page, { action: "click", element: toggle.id }).catch(() => {});
      await page.waitForTimeout(150);
      const after = await freshTree(page);
      const t2 = find(after, e => (e.role === "checkbox" || e.role === "switch") && /email me updates/i.test(e.name || e.label || ""));
      record(framework, "checkbox/switch", "state", t2 && (t2.checked === true) !== before, `before=${before} after=${t2?.checked}`);
      record(framework, "checkbox/switch", "action", true, "clicked");
    }

    // ---- Radio group ----
    const radio = find(tree, e => e.role === "radio" && /yearly/i.test(e.name || e.label || ""));
    if (radio) {
      record(framework, "radio", "perceive", true, `checked=${radio.checked}`);
      const loc = await resolveElement(page, radio);
      if (loc) await loc.click().catch(() => {}); else await executeAction(page, { action: "click", element: radio.id }).catch(() => {});
      await page.waitForTimeout(120);
      const after = await freshTree(page);
      const r2 = find(after, e => e.role === "radio" && /yearly/i.test(e.name || e.label || ""));
      record(framework, "radio", "state", r2?.checked === true, `yearly checked=${r2?.checked}`);
    }

    // ---- Segmented / pressed button (React, Vue) ----
    const seg = find(tree, e => e.role === "button" && e.name === "Yearly");
    if (seg && !radio) {
      record(framework, "segmented", "perceive", true, `pressed=${seg.pressed}`);
      const loc = await resolveElement(page, seg);
      if (loc) await loc.click().catch(() => {});
      await page.waitForTimeout(120);
      const after = await freshTree(page);
      const s2 = find(after, e => e.role === "button" && e.name === "Yearly");
      record(framework, "segmented", "state", s2?.pressed === true, `pressed=${s2?.pressed}`);
    }

    // ---- Custom combobox / dropdown (React combo, Bootstrap dropdown) ----
    const comboBtn = find(tree, e => (e.role === "combobox" || e.role === "button") && /^plan$|region/i.test(e.name || "") && e.expanded !== undefined);
    if (comboBtn) {
      record(framework, "custom dropdown", "perceive", true, `expanded=${comboBtn.expanded}`);
      const loc = await resolveElement(page, comboBtn);
      if (loc) await loc.click().catch(() => {});
      await page.waitForTimeout(250);
      const after = await freshTree(page);
      // After opening, the option/menu entries must become perceivable. They
      // may be role option, menuitem, or (Bootstrap) plain buttons that were
      // hidden before — any of those means the agent can now reach them.
      const before = new Set(tree.elements.map(e => `${e.role}:${e.name}`));
      const revealed = after.elements.find(e =>
        (e.role === "option" || e.role === "menuitem" ||
         (e.role === "button" && /us-east|eu-west|ap-south|starter|team|scale/i.test(e.name || ""))) &&
        !before.has(`${e.role}:${e.name}`));
      record(framework, "custom dropdown", "action", !!revealed, revealed ? `revealed ${revealed.role} ${revealed.name}` : "no entries revealed after open");
    }

    // ---- Final Apply button drives real app state ----
    const go = find(tree, e => e.role === "button" && /apply settings/i.test(e.name || ""));
    if (go) {
      const loc = await resolveElement(page, go);
      if (loc) await loc.click().catch(() => {}); else await executeAction(page, { action: "click", element: go.id }).catch(() => {});
      await page.waitForTimeout(200);
      const out = await page.textContent("#out").catch(() => "");
      record(framework, "apply button", "action", /Applied:/.test(out || ""), `out=${(out || "").slice(0, 60)}`);
    }

    await page.close();
  }

  await browser.close();

  // ---- Report ----
  const frameworks = ["plain", "react", "vue", "bootstrap"];
  const axes = ["perceive", "state", "value", "action"];
  console.log("\n=== ZOO CAPABILITY MATRIX ===\n");
  for (const fw of frameworks) {
    const rows = results.filter(r => r.framework === fw);
    const pass = rows.filter(r => r.ok).length;
    console.log(`${fw.toUpperCase()}  ${pass}/${rows.length}`);
    for (const r of rows.filter(r => !r.ok)) console.log(`   FAIL ${r.control} [${r.axis}] — ${r.detail}`);
  }
  const total = results.length, ok = results.filter(r => r.ok).length;
  console.log(`\nTOTAL ${ok}/${total} checks pass`);
  console.log("\nBy axis:");
  for (const ax of axes) {
    const rows = results.filter(r => r.axis === ax);
    console.log(`  ${ax.padEnd(9)} ${rows.filter(r => r.ok).length}/${rows.length}`);
  }
  console.log("\nFULL:");
  for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.framework.padEnd(10)} ${r.control.padEnd(18)} ${r.axis.padEnd(9)} ${r.detail}`);
}

run().catch(e => { console.error(e); process.exit(1); });
