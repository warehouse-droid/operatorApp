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

test("PO maps its source memo as the remark and clearing a local remark restores it", () => {
  assert.deepEqual(resolveScmScheduleRemark({
    orderKind: "PO",
    remarkOverride: " \n ",
    netSuiteMemo: "PO pickup instructions"
  }), {
    remark: "PO pickup instructions",
    remarkSource: "netsuite",
    remarkOverride: "",
    netSuiteMemo: "PO pickup instructions"
  });
  assert.equal(resolveScmScheduleRemark({orderKind:"PO",remarkOverride:"Local PO remark",netSuiteMemo:"Memo"}).remark,"Local PO remark");
  assert.equal(resolveScmScheduleRemark({orderKind:"CO",netSuiteMemo:"Other memo"}).remark,"");
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

test("a linked SO prefix preserves the local edit and underlying PO memo", () => {
  assert.deepEqual(resolveScmScheduleRemark({
    orderKind: "PO", remarkOverride: "Call vendor", netSuiteMemo: "Pickup at gate 2", remarkPrefix: "For SOB12345"
  }), {
    remark: "For SOB12345 Call vendor", remarkSource: "local", remarkOverride: "Call vendor",
    remarkPrefix: "For SOB12345", netSuiteMemo: "Pickup at gate 2"
  });
  assert.equal(resolveScmScheduleRemark({
    orderKind: "PO", remarkOverride: "", netSuiteMemo: "Pickup at gate 2", remarkPrefix: "For SOB12345"
  }).remark, "For SOB12345 Pickup at gate 2");
  assert.equal(resolveScmScheduleRemark({ orderKind: "PO", remarkPrefix: "For SOB12345" }).remark, "For SOB12345");
});

test("SO prefixes are idempotent and do not match longer SO numbers or transfer orders", () => {
  for (const base of ["For SOB12345", "for sob12345 Call vendor", "For SOB12345: call vendor"]) {
    const result = resolveScmScheduleRemark({ orderKind: "PO", remarkOverride: base, remarkPrefix: "For SOB12345" });
    assert.equal(result.remark, base);
  }
  assert.equal(resolveScmScheduleRemark({
    orderKind: "PO", remarkOverride: "For SOB123456 Call vendor", remarkPrefix: "For SOB12345"
  }).remark, "For SOB12345 For SOB123456 Call vendor");
  assert.equal(resolveScmScheduleRemark({
    orderKind: "TO", netSuiteMemo: "Transfer", remarkPrefix: "For SOB12345"
  }).remark, "Transfer");
});
