import assert from "node:assert/strict";
import test from "node:test";

import { vendorScheduleLabelCovers } from "../../../src/dispatch-enrichment.js";
import { smartScmBlanketProposalSourceMatchesPolicy } from "../../../src/smart-scm-blanket-repository.js";
import { canonicalVendorYardIdSql } from "../../../src/vendor-yard-identity.js";

test("summary schedule labels cover the weekdays they name", () => {
  const week = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const covered = (label) => week.filter((day) => vendorScheduleLabelCovers(label, day));
  assert.deepEqual(covered("Mon-Fri"), week.slice(0, 5));
  assert.deepEqual(covered("Mon-Sat"), week.slice(0, 6));
  assert.deepEqual(covered("Monday - Thursday"), week.slice(0, 4));
  assert.deepEqual(covered("Daily"), week, "Unrecognised labels cover the whole week.");
  assert.equal(vendorScheduleLabelCovers("Mon-Fri", "Holiday"), false);
});

test("Blanket pickup checks compare the yard when canonical rows are resolved", () => {
  const policy = { vendor_yard_id: 25, canonical_vendor_yard_id: 1, vendor_yard: "UNILOCK Ayr" };
  const proposal = { source_vendor_yard_id: 1, canonical_source_vendor_yard_id: 1, source_name: "UNILOCK Ayr" };
  assert.equal(smartScmBlanketProposalSourceMatchesPolicy(proposal, policy), true);
  assert.equal(
    smartScmBlanketProposalSourceMatchesPolicy({ ...proposal, canonical_source_vendor_yard_id: 4 }, policy),
    false,
    "A different yard must still be rejected."
  );
  assert.equal(
    smartScmBlanketProposalSourceMatchesPolicy({ source_vendor_yard_id: 25, source_name: "UNILOCK Ayr" }, { vendor_yard_id: 25, vendor_yard: "UNILOCK Ayr" }),
    true,
    "Callers without canonical rows keep exact row comparison."
  );
});

test("canonical vendor-yard SQL prefers the lowest active row of the same vendor and yard", () => {
  const sql = canonicalVendorYardIdSql("policy.vendor_yard_id");
  assert.match(sql, /LOWER\(canonical_yard\.vendor\) = LOWER\(source_yard\.vendor\)/);
  assert.match(sql, /LOWER\(canonical_yard\.yard\) = LOWER\(source_yard\.yard\)/);
  assert.match(sql, /ORDER BY canonical_yard\.active DESC, canonical_yard\.id/);
  assert.match(sql, /, policy\.vendor_yard_id\)$/, "Missing rows fall back to the stored id.");
});
