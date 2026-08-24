import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVerificationReview } from "../verificationAgent.js";

describe("parseVerificationReview", () => {
  it("accepts stepIndex on verified and contradicted checks", () => {
    const parsed = parseVerificationReview(JSON.stringify({
      verifications: [
        {
          title: "Creating a task",
          claim: "Creating a task adds it to the list.",
          status: "verified",
          evidence: "Step 4 showed the new task row in the list.",
          stepIndex: 4,
        },
        {
          title: "Deleting a task",
          claim: "Deleting a task removes it from the list.",
          status: "contradicted",
          evidence: "Step 8 still showed the deleted task row.",
          stepIndex: 8,
        },
      ],
    }));

    assert.equal(parsed[0].status, "verified");
    assert.equal(parsed[0].stepIndex, 4);
    assert.equal(parsed[1].status, "contradicted");
    assert.equal(parsed[1].stepIndex, 8);
  });

  it("tolerates missing and invalid stepIndex values", () => {
    const parsed = parseVerificationReview(JSON.stringify({
      verifications: [
        {
          claim: "Updating a task changes its text.",
          status: "verified",
          evidence: "The updated row appeared.",
        },
        {
          claim: "Saving a task shows feedback.",
          status: "verified",
          evidence: "The toast appeared.",
          stepIndex: "3",
        },
      ],
    }));

    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].stepIndex, undefined);
    assert.equal(parsed[1].stepIndex, undefined);
  });

  it("keeps reproSteps and suspectFiles only on contradicted checks", () => {
    const parsed = parseVerificationReview(JSON.stringify({
      verifications: [
        {
          title: "Sharpen slider",
          claim: "Dragging Sharpen changes the image.",
          status: "contradicted",
          evidence: "Slider still read 0% afterwards.",
          reproSteps: ["Open the editor", "Drag the Sharpen slider", "Value stays at 0%"],
          suspectFiles: ["components/editor/sections/ImageEnhanceSection.tsx"],
        },
        {
          // A verified check has nothing to reproduce and nothing to blame.
          title: "Creating a task",
          claim: "Creating a task adds it to the list.",
          status: "verified",
          evidence: "Step 4 showed the new row.",
          reproSteps: ["Open the app", "Add a task"],
          suspectFiles: ["components/editor/sections/ImageEnhanceSection.tsx"],
        },
      ],
    }), ["components/editor/sections/ImageEnhanceSection.tsx"]);

    assert.deepEqual(parsed[0]?.reproSteps, ["Open the editor", "Drag the Sharpen slider", "Value stays at 0%"]);
    assert.deepEqual(parsed[0]?.suspectFiles, ["components/editor/sections/ImageEnhanceSection.tsx"]);
    assert.equal(parsed[1]?.reproSteps, undefined);
    assert.equal(parsed[1]?.suspectFiles, undefined);
  });

  it("drops suspectFiles the diff never contained", () => {
    // A hallucinated path sends a maintainer to a file that does not exist,
    // so anything outside the supplied list must not survive parsing.
    const parsed = parseVerificationReview(JSON.stringify({
      verifications: [{
        title: "Sharpen slider",
        claim: "Dragging Sharpen changes the image.",
        status: "contradicted",
        evidence: "Slider still read 0%.",
        suspectFiles: ["src/totally/Invented.tsx", "ImageEnhanceSection.tsx"],
      }],
    }), ["components/editor/sections/ImageEnhanceSection.tsx"]);

    // Bare basename resolves to the real path; the invented one is dropped.
    assert.deepEqual(parsed[0]?.suspectFiles, ["components/editor/sections/ImageEnhanceSection.tsx"]);
  });

  it("omits suspectFiles when no file list was supplied", () => {
    const parsed = parseVerificationReview(JSON.stringify({
      verifications: [{
        title: "Sharpen slider",
        claim: "Dragging Sharpen changes the image.",
        status: "contradicted",
        evidence: "Slider still read 0%.",
        suspectFiles: ["components/editor/sections/ImageEnhanceSection.tsx"],
      }],
    }));
    assert.equal(parsed[0]?.suspectFiles, undefined);
    assert.equal(parsed[0]?.status, "contradicted");
  });
});
