import assert from "node:assert/strict";
import test from "node:test";

import {
  isRemarkOnlyScmSchedulePatch,
  normalizeScmScheduleRemarkOverride,
  resolveScmScheduleRemark
} from "../../../src/scm-schedule-remark.js";

test("a local TO remark wins without mutating the NetSuite Memo", () => {
  assert.deepEqual(resolveScmScheduleRemark({
    orderKind: "TO",
    remarkOverride: "  Call yard before arrival  ",
    netSuiteMemo: "Internal transfer"
  }), {
    remark: "Call yard before arrival",
    remarkSource: "local",
    remarkOverride: "Call yard before arrival",
    netSuiteMemo: "Internal transfer"
  });
});

test("a TO falls back to the latest NetSuite Memo and blank local input resets it", () => {
  assert.deepEqual(resolveScmScheduleRemark({
    orderKind: "to",
    remarkOverride: "  ",
    netSuiteMemo: "  Updated NetSuite memo  "
  }), {
    remark: "Updated NetSuite memo",
    remarkSource: "netsuite",
    remarkOverride: "",
    netSuiteMemo: "Updated NetSuite memo"
  });
  assert.equal(normalizeScmScheduleRemarkOverride(" \n "), null);
});

test("PO never inherits its source memo implicitly", () => {
  assert.deepEqual(resolveScmScheduleRemark({
    orderKind: "PO",
    netSuiteMemo: "Do not expose this PO memo"
  }), {
    remark: "",
    remarkSource: "none",
    remarkOverride: "",
    netSuiteMemo: "Do not expose this PO memo"
  });
});

test("normalization preserves internal newlines and enforces the 2,000 character boundary", () => {
  assert.equal(normalizeScmScheduleRemarkOverride("  first\nsecond  "), "first\nsecond");
  assert.equal(normalizeScmScheduleRemarkOverride("x".repeat(2000)), "x".repeat(2000));
  assert.throws(
    () => normalizeScmScheduleRemarkOverride("x".repeat(2001)),
    (error) => error?.status === 400 && error?.code === "SCM_REMARK_TOO_LONG"
  );
});

test("remark-only patch classification permits concurrency/audit metadata only", () => {
  assert.equal(isRemarkOnlyScmSchedulePatch({
    orderKind: "PO",
    expectedUpdatedAt: "2026-08-27T00:00:00.000Z",
    remarkOverride: "Safe non-operational note",
    audit: { sessionId: "test" }
  }), true);
  assert.equal(isRemarkOnlyScmSchedulePatch({ remark_override: "snake case" }), true);
  assert.equal(isRemarkOnlyScmSchedulePatch({ remarkOverride: "", status: "Hold" }), false);
  assert.equal(isRemarkOnlyScmSchedulePatch({ status: "Hold" }), false);
});
