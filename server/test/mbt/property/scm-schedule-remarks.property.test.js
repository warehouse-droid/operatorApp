import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeScmScheduleRemarkOverride,
  resolveScmScheduleRemark
} from "../../../src/scm-schedule-remark.js";

test("every nonblank local override dominates every generated TO memo", () => {
  for (let index = 1; index <= 200; index += 1) {
    const local = ` local-${index} `;
    const memo = `memo-${201 - index}`;
    const resolved = resolveScmScheduleRemark({ orderKind: "TO", remarkOverride: local, netSuiteMemo: memo });
    assert.equal(resolved.remark, local.trim());
    assert.equal(resolved.remarkSource, "local");
    assert.equal(resolved.netSuiteMemo, memo);
  }
});

test("blank variants always reset the override instead of shadowing a TO memo", () => {
  for (const blank of [undefined, null, "", " ", "\n", "\t\r\n "]) {
    assert.equal(normalizeScmScheduleRemarkOverride(blank), null);
    const resolved = resolveScmScheduleRemark({ orderKind: "TO", remarkOverride: blank, netSuiteMemo: "Memo" });
    assert.equal(resolved.remark, "Memo");
    assert.equal(resolved.remarkSource, "netsuite");
  }
});
