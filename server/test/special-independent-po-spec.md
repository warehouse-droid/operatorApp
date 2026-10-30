# Independent Special Request Purchase Orders

Spec approval: not obtained (autonomous run). User clarified that UOM means the
SCM UOM field; it must be a NetSuite-backed dropdown, not free text.

Acceptance scenarios:

1. Creating a PO with a different description, quantity, UOM or packing counts
   leaves the issued SO, its saved lines, prices and request descriptions intact.
2. SCM controls quantity, UOM, PLT, SEC, LYR and PCS for every PO material.
   UOM options come from the selected active NetSuite item's units type. Invalid,
   stale or forged choices are rejected before submission. Items without a units
   type explicitly show NetSuite's no-unit option.
3. Add Item searches synced items and creates removable PO-only lines, including
   purchase fees. Added lines carry description, quantity, valid UOM, packing and
   cost, persist through errors/reload, and contribute to PO totals. They never
   become request/SO lines. PALLET and vendor discount retain their existing editors.
4. Missing/duplicate request lines, unknown items, invalid numeric inputs and
   too many added items fail atomically. Approval, revision and operation locks
   remain enforced. Failed submissions recover by marker without another POST.
5. Case/SO/PO references remain for tracking. Independent orders do not require
   equal line contents or an automatic native NetSuite link. Existing issued
   native POs remain recoverable without rewriting the SO.

Failure model: unintended SO writes (service spies plus database snapshots),
invalid amounts/units (boundary and property tests), duplicate POs (recovery
regression tests), partial local updates (rollback tests), wrong item choices or
lost browser edits (browser tests), unsafe dispatch allocation (existing custom
link guards). Existing NetSuite-linked orders are not retroactively detached.

Setup: existing Node test runner, Playwright, ESLint, TypeScript, c8 and fast-check;
no dependencies, commits or schema migration. Use bounded disposable Compose and
the retention wrapper; register teardown before launch. Keep concise evidence
here; remove all generated test output. Production deployment is a separate step.

Schema revision: the existing PO ancillary-line constraint permits only PALLET.
One additive migration will allow other positive item IDs for PO-only lines;
the dedicated PALLET unique index stays intact. Validate migration reapplication
and rollback to the old constraint when no added lines exist. After added lines
exist, rollback must preserve those records rather than dropping them.

Routing clarification: independence concerns PO/SO content and NetSuite writes.
Keep existing Dispatch route choices for application-created orders; a reviewed
PO must not automatically become a reference-only manual link. Each order still
reconciles to its own snapshot. Explicit manual links retain their existing rules.

Release plan: apply only this task's diff over the current live source, rerun the
isolated checks on that candidate, then publish with the existing scoped release
and rollback mechanism. Check for in-flight writes, apply only migration 322 in
a bounded transaction, preserve the prior constraint definition and image, and
verify health, asset hashes, authentication and read-only NetSuite UOM metadata.
Do not create test orders or change any customer SO/PO in production.
