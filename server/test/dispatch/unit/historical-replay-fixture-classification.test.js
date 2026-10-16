import assert from "node:assert/strict";
import test from "node:test";
import { historicalReplayFixtureReason,historicalReplayInScope,historicalReplayDraftReason } from "../../../tools/dispatch-all-history-fixture-classification.mjs";

test("verified synthetic boards are identified without turning a rejection into a pass",() => {
  assert.ok(historicalReplayFixtureReason({note: "isolated dispatch v2 fixture",date_text: "2039-08-09"},
    {orders: [{id: "GOB-TEST"}],summary: {testOnly: true}}));
  assert.ok(historicalReplayFixtureReason({note: "global CO lifecycle regression",date_text: "2216-01-15"},
    {orders: [{id: "GOA-GLOBAL-0FB08978-3",testOnly: true}]}));
  assert.ok(historicalReplayFixtureReason({note: "dependency fence digest regression",date_text: "2216-01-21"},{orders: []}));
});

test("operational history cannot be excluded by a date, a marker or a note alone",() => {
  assert.equal(historicalReplayFixtureReason({note: "",date_text: "2098-12-30"},{orders: []}),null);
  assert.equal(historicalReplayFixtureReason({note: "business plan",date_text: "2039-08-09"},{summary: {testOnly: true}}),null);
  assert.equal(historicalReplayFixtureReason({note: "isolated dispatch v2 fixture",date_text: "2039-08-09"},{summary: {}}),null);
  assert.equal(historicalReplayFixtureReason({note: "global CO lifecycle regression",date_text: "2026-09-03"},{orders: []}),null);
  assert.equal(historicalReplayFixtureReason({note: "global CO lifecycle regression",date_text: "2216-01-15"},
    {orders: [{id: "SOB116758"}]}),null);
});

test("the requested August/September scope uses plan dates and includes both boundaries",() => {
  for (const date of ["2026-08-01","2026-08-31","2026-09-01","2026-09-30"]) {
    assert.equal(historicalReplayInScope({date_text: date}),true,date);
  }
  for (const date of ["2026-07-31","2026-10-01","2039-08-09",""]) {
    assert.equal(historicalReplayInScope({date_text: date}),false,date);
  }
});

test("rejected recovery drafts require corroborating unapplied recovery metadata",() => {
  const draft = {archive_reason: "save_recovery",checkpoint_kind: "recovery",summary: {saveRecovery: {applied: false}}};
  assert.ok(historicalReplayDraftReason(draft));
  assert.equal(historicalReplayDraftReason({...draft,summary: {saveRecovery: {applied: true}}}),null);
  assert.equal(historicalReplayDraftReason({...draft,archive_reason: "before_incremental_command"}),null);
  assert.equal(historicalReplayDraftReason({...draft,checkpoint_kind: "event"}),null);
});
