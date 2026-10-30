Linked PO pickup correction — 2026-10-28

Tier 3, scoped to route preservation and the additive Driver display field.
Spec approval: not obtained (autonomous run). The user requested fixing today's
CC46868 / Li / Load 2 and using sales UOM for linked quantity calculations.

The live arithmetic already gives zero yard cargo: 21 EACH of PALLET and
2030.91 SQFT are fully allocated to LOINC-038227. The saved unstarted 150 visit
survives because reconciliation only removes dependency-generated visits.
The Driver projection discards the PO manifest reference.

Acceptance tests:
1. Reconcile an explicit fully linked SO/group pickup: remove its empty source
   visit, retain the vendor pickup and delivery, and invalidate future estimates.
2. Partial allocation keeps the source visit; compare sales quantities, never
   subtract PCS/PLT from EACH/SQFT. Existing conversion and packing suites pass.
3. Mixed visits retain other orders; unknown legacy quantities, unlinked orders,
   custom orders, and explicit pickup address overrides survive. Input stays
   unchanged; repeated reconciliation is idempotent.
4. In-progress/completed visits and the executed prefix survive, including
   active travel. A scoped repair locks the fleet and plan, checks the revision,
   refuses recorded target activity, writes an audit atomically, and is idempotent.
5. Driver pickup cards show each linked PO reference for that pickup location,
   de-duplicated, escaped, and retained in offline snapshots. Other vendors and
   delivery cards do not show unrelated PO references. Cargo is not duplicated.
6. Deploy only the scoped files over the captured live image with an app-only
   rollback. Preserve configuration, dependency services and driver evidence.

Failure model: stale/partial links could remove required cargo (unit/property
tests); a shared visit could lose another order (mixed-order tests); activity
could race a repair (transaction lock/revision guards and refusal tests);
unescaped references could inject markup (hostile rendering test); stale PWA
assets could hide the change (asset-version checks). Physical-device upgrade
and external NetSuite posting are outside this task.

Use existing Node, PostgreSQL, fast-check, ESLint, TypeScript and coverage tools.
No dependencies, migrations, Git commits or NetSuite writes. All tests use the
bounded disposable runner and unique artifact directory, with unconditional
container, volume, network and artifact cleanup. Retain concise evidence and
operational deployment/repair audit records.

Investigation correction after historical comparison:
The cleanup gap is secondary. The catalog detail reader returns refreshed split
group definitions without reapplying active PO allocations. Group source refresh
replaces linked member items with split definitions that lack allocation totals,
while retaining the PO manifest. Replaying getDispatchOrderCatalogOrder returns
150 + Techo for GOM-6894S1-6895S1, but only Techo for the ordinary member groups
GOB-123453-123464 and GOA-10588-10650. The successful historical split-containing
GOA-10208-10209S1 also now loses its PALLET allocation in this reader, confirming
this is a general split refresh defect, not an isolated pallet conversion.

7. Replay the four minimal historical fixtures through the actual catalog
   repository and browser pickup creation/cleanup. Reapply current active PO
   allocations on catalog reads, clear cancelled projections, preserve partial
   sales residuals, and repeat after parent source refresh. The no-yard-pickup
   result must agree with plan reconciliation and Driver content. No production
   orders, credentials, customer details or data volumes enter the test DB.

Producer correction (supersedes the read-time proposal in criterion 7):
The user requires a correct feed without repeated refreshes. Reapply active PO
allocations in the existing source rebuild transaction, before publishing split
and group definitions. Do not add queries to order-detail reads, refresh timers,
or client retries. Test fixtures retain only sanitized historical order shapes,
line identifiers and quantities; no complete production records are copied.
An allocation failure must roll back the entire feed update. Repeated builds,
cancelled links, partial allocations and ordinary groups must remain correct.

One-time remediation scope: read-only comparison found six active group
definitions with matching active allocations but missing allocated sales totals.
Correct those confirmed entries once, preserving their cargo and historical
plan/driver records. Preview rolls back, each correction is audited, and a
second execution makes no changes. This adds no refresh job or read-time work.
