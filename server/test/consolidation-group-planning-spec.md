# Consolidation Load: planned groups with unassigned child records

Spec approval: not obtained (autonomous run). The user explicitly requested this fix after the Sep-16 diagnosis. Tier 3 because resolving a planned load affects eligibility and grouping during fulfillment. Preserve the prior, undeployed IF/IR timing/photo/receiving changes.

## Failure model

- Missing grouped children: list and preview must resolve their active group's plan date even when every child has null dispatch fields.
- Wrong or stale assignment: resolve actual truck/load from the current plan snapshot; reject missing, canceled, return-only, conflicting or changed assignments.
- Mixed yards, loads, duplicates or quantities: retain existing authorization, snapshot, lock and replay checks; no new NetSuite posting path.
- Reading a list changes operations: the fix adds read queries and in-memory enrichment only. Production verification uses explicit READ ONLY transactions and never creates previews, loads, IFs or IRs.

## Acceptance

1. Packed groups whose child dispatch date/truck/load are null appear as their original orders. No standalone order is needed to supply the date. Retain source identities, quantities and actual child yards.
2. Selecting listed child IDs or selecting the group produces the same original-order preview and planned load. Submit/revalidation can reload those children successfully; a replay does not duplicate loading.
3. Group date fallback is scoped to active membership of the same order family in a non-canceled plan. A child's existing dispatch date retains precedence. Conflicting group dates must not pick one arbitrarily.
4. Missing drop stops, return-only loads and multiple load assignments remain ineligible. A plan/load change after preview is rejected with no accepted load or quantity changes. Existing yard and overlap rejection remains.
5. Read-only replay for 3445 / Sep-16 includes SOA08600, SOA08648, SOB120124, SOB120358, SOB120251, SOB120252, SOB120300 and SOB120301, plus the two already visible standalone orders, if the production state is unchanged. Their truck/load comes from the current snapshot.

## Setup and checks

No dependencies, migrations, PWA edits or deployment. Reuse the existing isolated Node/PostgreSQL test wrapper and locked test tools. Preserve a pre-task source copy and the just-completed 2,500-test baseline (2 known infrastructure failures, 1 skip). Write regression tests and observe RED; implement the narrow lookup fix; run focused tests, generated cases, mutation, baseline type/lint comparisons, changed-line coverage, browser regression, a fresh full suite and read-only production replay. Persist reproducible tools and evidence. No commit or unrelated cleanup.
