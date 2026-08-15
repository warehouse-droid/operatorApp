# MBBS Rate-Card Charging Policy — Verification Evidence

Date: 2026-08-14 (UTC)

Scope: make the MBBS Sales Order, Transfer Order, Purchase Order, grouping,
additional-drop, and Dispatch-load-split charging rules visible in Rate Cards;
make the direct-pickup TO and PO additional-drop unit prices effective-dated,
editable in unused drafts, and immutable after activation/use; use the selected
version's policy for preview, conversion, and durable billing evidence.

## Safety boundary

- Feature tests ran against the disposable Compose project
  `mbbs-mbt-p1-test` and its isolated tmpfs PostgreSQL database.
- No feature deployment, production migration, NetSuite request, outbox write,
  Dispatch mutation, or production database mutation was performed.
- No feature image was deployed. During verification, Docker Engine 29.6.1's
  embedded BuildKit crashed on a concurrent two-target test-image build with
  `concurrent map iteration and map write`. Systemd restarted Docker; the
  pre-existing production images were restarted without a rebuild or database
  mutation. Subsequent image builds were strictly sequential, and all three
  production services were verified healthy after testing.
- Migration 160 is forward-only. It creates one policy row per MBBS rate-card
  version and backfills existing MBBS versions with explicit CAD 100.00 unit
  prices; runtime billing has no constant-price fallback.
- The isolated containers, network, volume, and generated test images were
  removed after verification. They contained no production data.

## RED evidence

Before implementation, all seven initial policy acceptance checks failed:
there was no visible charging policy, no version-owned storage, no strict
policy validator, and direct-TO/PO arithmetic still used a hidden constant.
The first browser pass then exposed a genuine serialization defect: the
dedicated MBBS item defaulted to ordinary BIN delivery, causing its visible
policy to be submitted as `null`. The UI was corrected so that item can emit
only the `mbbs_cross_charge` pricing purpose.

## GREEN evidence

| Gate | Result |
|---|---|
| Fresh official migration run | migrations 001–160 applied |
| Focused policy, lifecycle, property, and conversion packet | 37/37 passed |
| Generated arithmetic cases | 1,000 direct TO + 1,000 PO + 1,000 other-rule cases passed |
| Strict policy-module coverage | 100% statements, branches, functions, and lines |
| Rate-card/billing compatibility packet | 56/56 passed |
| Focused mutation packet | 26/26 killed (100%) |
| Rate-card editor browser flow | 6/6 passed: desktop Chromium, mobile Chromium, mobile WebKit |
| Complete MBT Node suite | 302/302 isolated files; 1,625 tests passed |
| TypeScript/JSDoc check | passed |
| Full MBT ESLint, zero-warning policy | passed |
| Legacy browser-script syntax check | passed |
| Changed-line secret scan | 65 paths passed; zero findings |
| Dependency license policy | 383 packages passed; existing `buffers@0.1.1` metadata exception retained |
| `git diff --check` | passed |

## Proved invariants

- The rules shown to the user and the rule identifiers used by the server are
  one strict, allowlisted schema-v1 contract.
- Only two values are editable: direct-pickup TO unit cents and PO
  additional-drop unit cents. Both use exact integer-cent parsing and reject
  negatives, fractional cents, unsafe integers, and extra fields.
- SO is charged independently once per order; an explicit SO group is one
  charge retaining all child references.
- A replenishment TO is charged once at the full route price. A direct-pickup
  or drop-ship TO is charged once at the configured direct-TO unit price and
  contributes no distance-band amount.
- PO split references sharing one business leg retain one distance charge,
  allocate exact cents evenly, and add the configured unit price for every
  distinct drop after the first.
- Dispatch load splits do not alter SO, TO, or PO billing identity or amount.
- Draft changes use optimistic revision checks. Activation requires a policy;
  active or used policy rows are database-immutable; cloning copies the policy
  into a new editable version with fresh audit ownership.
- Candidate preview and conversion independently reload the selected active
  version, recalculate server-side, and freeze the complete policy and selected
  unit price into durable billing evidence.
- Existing MBBS versions receive explicit CAD 100.00 rows during migration,
  preserving prior behavior without a hidden runtime default.

## Mutation packet

The focused packet detects swapped direct/PO prices, negative price acceptance,
editable rule identifiers, missing-policy fallback, hidden policy detail,
missing durable policy evidence, direct-TO distance charging, PO grouping/drop
regressions, unchecked/manual selection regressions, missing immutable
snapshots, atomicity loss, and optimistic-revision bypass.
