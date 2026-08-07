# Hand-triage of the fixv3 clean-corpus noise (33 reports over 18 runs)

Every report below was checked against the surface's source, and the ambiguous
ones were reproduced in a real browser. "Clean corpus" means no bug was
knowingly planted, so a REAL verdict means the surface genuinely has that
defect, not that the report was expected.

Verdicts: REAL = a defect a reasonable engineer would accept.
NOISE = the product did nothing wrong, or the tester's own failure was
reported as the product's.

## Pass A (16 reports)

| # | Surface | Verdict | Why |
|---|---|---|---|
| 1 | bookflow-index | NOISE | An invalid code leaving a previously-VALID promo applied, with an error shown, is defensible. "Should clear TEAM15" is invented. |
| 2 | bookflow-index | REAL | `<label>` has no `for` and does not wrap the input — genuinely unassociated. |
| 3 | bookflow-account | NOISE | Impossible co-occurrence: `errName` is cleared at the top of every submit, so the required-name error cannot be on screen beside a success. |
| 4 | bookflow-account | REAL (minor) | The saved confirmation is only cleared on the next submit, so it persists over later edits. |
| 5 | gridworks-index | REAL (minor) | The empty state is one `colspan=6` cell, so column widths collapse and headers shift. |
| 6 | gridworks-index | NOISE | Evidence is the agent's own fill failing ("repeated action with no page state change"), reported as the app's. |
| 7 | gridworks-report | NOISE — ENGINE | `send.onclick = alert("Report sent.")` genuinely fires. The run attributed it to the earlier "Export queued." alert and reported no confirmation. |
| 8 | gridworks-schedule | REAL (if weekday wrong) | Needs the render checked; a wrong weekday for a booked date is a true defect. |
| 9 | stockroom-index | REAL | Item/Movement/Quantity labels are unassociated — same class as #2. |
| 10 | stockroom-audit | NOISE — ENGINE | `keydown` → Escape → `closeModal()` exists and works. The keypress did not reach the document listener. |
| 11 | stockroom-audit | NOISE — ENGINE | Same root cause as #10, restated as a failed check. |
| 12 | stockroom-audit | NOISE | Steppers have no lower bound, so "cannot go below zero" is invented; the "no page-state change" is a stale handle after `render()` replaced the row. |
| 13 | bookflow-tickets | REAL | Attendee name is interpolated into `innerHTML` unescaped — `<img>` renders. Genuine injection. |
| 14 | bookflow-tickets | REAL (minor) | The name-required error is only rewritten on the next buy, so it goes stale. |
| 15 | bookflow-tickets | NOISE | Buying is deliberately repeatable and appends; the second purchase simply never registered. |
| 16 | bookflow-tickets | REAL | Correctly contradicts a claim of literal rendering — the same injection as #13. |

## Pass B (17 reports)

| # | Surface | Verdict | Why |
|---|---|---|---|
| 1 | bookflow-index | NOISE — ENGINE | TEAM15 IS valid (15%). Reproduced by hand: typing it gives −$18.00 on $120. Apply was clicked on an EMPTY field whose placeholder reads "TEAM15". |
| 2 | bookflow-index | NOISE | No reload happened, so promo state legitimately persisted. |
| 3 | bookflow-index | NOISE — ENGINE | Same as B1, restated as a failed check. |
| 4 | bookflow-account | NOISE | "Validation must not move controls" is invented; inserting an error message shifts layout by design. |
| 5 | bookflow-account | NOISE | Same as B4. |
| 6 | bookflow-checkout | NOISE | `placing` guard AND `pay.disabled` block re-entry. Two SEQUENTIAL orders were misread as one double-submit. |
| 7 | gridworks-index | REAL | `closeSelected()` clears `state.selected` but never unchecks the select-all box. |
| 8 | gridworks-index | REAL | Row checkboxes have no accessible name. |
| 9 | gridworks-report | NOISE — ENGINE | Same alert attribution as A7. |
| 10 | stockroom-index | NOISE | Cable had 20 on hand; shipping 19 is permitted and left 1. The agent reported its own correct numbers as a failure. |
| 11 | stockroom-index | REAL (minor) | Right-aligned "Reorder at" abuts "Status" with no gap. |
| 12 | stockroom-index | REAL (minor) | 1.5 passes `qty < 1` validation, producing fractional stock. |
| 13 | stockroom-index | NOISE | Same as B10. |
| 14 | stockroom-index | REAL (minor) | Same as B12. |
| 15 | stockroom-audit | NOISE — ENGINE | The dialog is `display:none` until submit, yet was exposed in the a11y tree; clicking its Close timed out. |
| 16 | bookflow-tickets | REAL | Injection, same as A13. |
| 17 | bookflow-tickets | REAL | Correctly contradicts literal-rendering, same as A16. |

## Totals

    REAL   15 / 33   (45%)
    NOISE  18 / 33   (55%)

Of the 18 noise reports, **8 trace to engine defects** rather than to the
model's judgement — meaning they are fixable mechanically, not by prompting:

| Engine cause | Reports | Status |
|---|---|---|
| Hidden elements offered as real controls | A10, A11, B15 | FIXED — `isRendered()` gate in `buildTree` |
| Second `alert()` attributed to the first | A7, B9 | open |
| Placeholder read as the field's value | B1, B3 | partially addressed; still firing |
| Stale element handle after re-render | A12 | open |

The remaining 10 are model judgement — dominated by **invented requirements**
(A1, B4, B5, B6, B10, B13): the agent decides the product ought to behave some
way nothing promised, then reports the difference. B10 is the clearest case —
it reported the correct numbers and still called them a failure.
