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
});
