# SO action lock and material row — 25 September 2026

Spec approval: not obtained (autonomous follow-up under existing authorization).
Tier 2 frontend fix; retain the server's existing quantity-review protection.
No dependencies, commits, data migration or live NetSuite writes. Reuse the
isolated browser/database tooling and deploy only reviewed frontend changes.

Acceptance:

1. Reproduce SPREQ-000005's pending 500 → 50 PLT review. Both Create in NetSuite
   and Skip SO creation are disabled, visibly grey, show an unavailable cursor,
   and have an adjacent explanation that SCM confirmation is required.
2. Editing SO quantity disables both actions immediately and explains that the
   draft must be saved. Saving a quantity change keeps them disabled until SCM
   confirms. Refresh preserves the pending lock; SCM approval releases it.
3. Uploading delivery media while quantity is edited retains that quantity and
   the disabled actions until the draft is saved. Failed saves retain the lock.
   Forced click dispatch cannot issue a create/skip request while blocked.
4. At desktop width, Sales quantity, Sales UOM, original rate, discount and
   subtotal share one row in each accepted material. Description stays full
   width; the locked rate, calculation and other three-column forms are retained.
   Narrow screens wrap these fields without horizontal overflow.

Failure model and evidence: real browser checks cover misleading disabled styles,
dirty state lost on rerender/upload, pending-review re-enable, forged clicks and
responsive layout. Retain the existing frontend and workflow regression tests;
manual browser faults must be caught. No pricing/API logic changes, so existing
pricing properties are retained rather than adding layout-only property tests.
Scoped image hashes and live read-only verification protect unrelated deployment
state. Production SPREQ-000005 is never changed by the tests.
