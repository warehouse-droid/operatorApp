# Repair the failing application tests

Authorization: the user requested fixing the 588 remaining failures after the
release and push of `859dbc9`. Spec approval: not obtained (autonomous run).
Use the existing old-coder workflow; treat database isolation, posting,
authorization and concurrency changes as Tier 3.

Acceptance criteria:

1. The standard disposable runner can launch the existing Chromium browser
   fixtures with its read-only root filesystem and bounded writable tmpfs.
2. Test database guards accept the standard isolated `db` service and per-file
   disposable clones, while rejecting live/non-test database targets. Replace
   obsolete host assumptions with an equally strict shared isolation guard.
3. Fixtures establish the prerequisites for the business behavior they test:
   feature flags, completed jobs, schema fields and API contracts. Diagnose a
   missing prerequisite separately from an application defect.
4. Preserve business assertions during setup repairs. Any obsolete assertion
   requires an explicit, appended rationale tied to current intended behavior;
   do not skip cases, broaden tolerances or remove failing coverage.
5. Investigate remaining failures and fix confirmed defects, prioritizing
   fulfillment, receipts, quantities, financial posting and access control.
   Keep external-write guards and production data unchanged during validation.
6. Complete the full existing 1,253-file selection plus any new regression files
   with zero failures/cancellations and no newly skipped cases. Run affected
   types/lint, changed-code coverage, mutation/property checks where applicable,
   and order/flakiness checks. Record actual final results and any limits.
7. Every run uses the standard isolated Compose configuration, the shared
   4 GiB/two-CPU slice, bounded containers, per-file databases, registered
   teardown and a unique retention-managed artifact directory. Remove all
   disposable resources/output even on failure and verify production health.

Failure model: accidentally targeting production data (strict database guard
and hostile-input tests); masking business bugs with fixture edits (frozen
behavioral assertions and mutation checks); leaking test state (per-file
database clones and order checks); incorrect posting/quantities (existing
integration/property cases); leaked containers/data (unconditional teardown).

Setup: use existing Node, Python, Docker, Playwright and repository dependencies;
install no new dependency. Keep the historical release reports unchanged. Add
a reproducible repair runner and concise diagnostic/evidence reports under the
existing tools/test conventions. Make source changes reviewable in Git and use
the established commit/push workflow once validation is complete.

Initial baseline: 7,577 tests in 1,253 files; 6,987 passed, 588 failed, one was
cancelled and one skipped. Failures reproduced on the prior deployed source.
This task's acceptance gate is a passing suite, rather than a comparison with
that failing baseline.

Additional fixture prerequisites: the status-following outbox test explicitly
enables the mirror source role locally, restoring it in teardown; no worker or
external connection is started. The load-followup pickup fixture seeds new
packing after the documented Delivery-to-Pick-Up release trigger (migration
306). A missing production ETA is invalid only in explicit `dated` mode.

The posting rounding specification forbids new SQFT receipts with zero live
remaining quantity. Partial-PO tests retain exact selected quantities and split
parent identity while additionally rejecting completed/closed selections. Each
generated case also checks its eligible counterpart to detect false rejection.

Diagnosis update: migration 301 explicitly removes automatic Driver-completion
IF queueing and replaces it with Operator-load queueing. Legacy trigger tests
must be revised to the documented current trigger, preserving quantity,
identity and ownership checks and adding the negative Driver-only assertion.
Do not restore the retired automatic posting trigger to satisfy old tests.
The configuration-seam fixture also omitted a newly imported recency module;
copying that dependency repairs fixture setup without changing assertions.

Application-defect update: the Operator page and service worker currently use
different script/style URLs, so installation can cache a different shell from
the one requested by the page. Align the complete URLs and advance the cache
generation; retain the existing exact-URL, cache-reload and Driver-cache tests.

The completion projection intentionally derives display status from order
evidence. Separately, the saved operational-completion flag remains a write
lock in database triggers and other repository edits. Line/header edits must
honor that lock before writes, returning 409 instead of a trigger-driven 500 or
allowing a header change. Preserve the evidence-based display projection and
all existing edit assertions; validate both completed and editable cases.

Obsolete-contract update: cache tests pin several mutually incompatible past
release URLs (Driver v41/v47 and multiple September Operator builds). Retarget
those fixtures to the installed release, keeping exact URLs, generation checks,
atomic download counts, failure rollback and offline-data preservation checks.
The generation name is independent of an asset URL's complete query string.

Selected-card tests currently count conversation-alert requests triggered by
browser focus. The selection contract is zero queue/detail reloads; independent
unread-alert refresh remains valid. Count those queue/detail routes explicitly
while retaining the synchronous-render and actual DOM-identity assertions.

Additional setup repair: replace remaining retired database aliases and the
old mbt_verify database assumption with the same strict disposable guard;
complete DOM/network stubs and create output directories before coverage writes.
No product behavior is changed by these fixture repairs.

Contract reconciliation (each retains the corresponding safety assertions):

- `stock-request-followups-spec.md` permits linking an SO after current SCM
  review and treats the link as customer acceptance. Pending reviewed material
  is valid for SO linkage; pending PO review additionally requires that SO.
  Linked SOs report processing while their separate supply reasons remain visible.
- `special-independent-po-spec.md` makes new PO content independent of the SO.
  Tests must assert no SO description writes, exact PO content and recovery of
  already submitted legacy native POs. PO browser fixtures must provide valid
  item-backed UOM choices. All four explicit physical packing fields are retained.
- Special transfer ETA is calculated from SO placement (`special-stock-transfer`
  integration coverage). Before placement, date is null with `so_placement` mode;
  production and historical `dated` responses still require their supplied ETA.
- Current Special stages distinguish missing SO, approved PO, a queued dispatch
  reference, and vendor confirmation. A real PO alone is not dispatch handoff;
  explicit test-skip paths remain separate. Preserve terminal-state precedence.
- `stock-request-conversation-20261016-spec.md` explicitly replaces scattered
  reply/Ask Sales editors with the common conversation panel. Browser coverage
  must exercise that panel and its context, authorization and draft retention.
- `operator-posting-pack-quantities-spec.md` requires PLT/LYR/SEC/PCS, including
  zeros, on selected posting lines. Exact payload assertions must include them;
  unselected lines and all posting quantities retain their previous assertions.
- `driver-reconnect-spec.json` explicitly excludes billed-only cleanup from
  Dispatch/Driver while preserving closed/cancelled guards. Route-prefix tests
  should trigger closed-order maintenance when testing its execution lock.
- Saved quote documents remain accessible alongside linked order PDFs, including
  completed requests (`special-workflow-documents` unit coverage). Remaining-order
  closure preserves prior execution (`special-delivery-recovery-20261016.spec.json`).
- Alert badges now open the complete actionable list. Dismissing an event clears
  unread notification state; outstanding action requirements remain until resolved.

Additional confirmed defect: the menu-order catalog omits current Repair,
Order Reopen and Stock Check links. Synchronize the catalog with the sidebar;
retain exact catalog parity tests, allowing inline as well as multiline arrays.

Further reconciliation and regression findings:

- Source snapshots now freeze each test run and are removed by retention teardown.
  Files in snapshots must be readable by the unprivileged container user, including
  files that were originally readable only by the workspace owner's matching UID.
- Saved grouped orders must not enter the numeric-only local-reopen lookup. Keep
  the complete multi-yard group access tests unchanged to prove filtering remains
  effective. Catalog parity also includes MBR Setup and the current module order.
- Login's fallback discarded valid secondary MBT authorities when the primary
  role lacked a route and the server omitted its home. Replace obsolete source
  regexes with executable sign-in cases, reproduce that failure, then include
  secondary routes. Preserve the unauthorized-return-URL rejection and shared token.
- Migration readiness and mutation ownership inventories must include all current
  files. Preserve missing-migration and missing-runner detection, rather than
  fixing the suite to historical migration 205.
- Physical packing fields on Special SO/PO lines normalize empty/zero inputs to
  null (`sales-order-null-packs`); Operator IF/IR descriptive fields use explicit
  safe integer zeros. These are different contracts and must not be conflated.
- Direct PO allocation evidence deliberately uses numeric PO identity, including
  renamed references. The negative route test must change the actual physical
  route identity, keeping its persisted-error and no-enqueue assertions.
- Layout contracts follow the current document-scroll design; shared material
  helpers own the UOM dropdown. Keep actual rendering and multilingual checks.
  The missing disposable packing capture is replaced by a small synthetic 25-pallet
  urgent-load regression, explicitly labelled as synthetic rather than captured.

Further reconciliation: Special account selection retains the enquiry customer
and stores the SO account separately (migration 238 and the existing
`special-request-enhancements` acceptance tests). Dispatch may read local item
rate-card lookups; all item mutations retain Admin authorization.

Credit-memo recovery fixtures preserve the admitted restocking fee and use a
distinct discount item for later accounting additions. A corrected draft
restores its full original line set, including its fee. C1/C2 material and
no-duplicate-write assertions remain unchanged.

Legacy quantity-race tests now explicitly seed already-started remote journals
with their persisted plans. Current proposals remain local; the pre-existing
remote recovery path still must preserve exact pricing, webhook transitions,
idempotence and lost-acknowledgement recovery. PO creation is independent of
SO quantities/descriptions; native PO recovery applies only to prior submissions.

Regular list tests distinguish the Regular queue from Special detail access,
retaining their exhaustive authorization matrix. The 2026-10-26 clarification
in `regular-stock-delivery-simple-spec.md` permits Delivery without a pallet
conversion, using the full Sales quantity and zero calculated pallets.
Completed Special alert fixtures provide actual SO fulfillment and PO receipt
evidence, rather than relying on the legacy operational-completion flag.

Additional observed application regressions (existing assertions remain frozen):

- Switching to Waitlist using the tab keyboard must retain focus on the selected
  tab. Its render path must use the same focus preservation as the other tabs.
- Opening a returned-stock pool, including the already selected pool, acknowledges
  that return event and removes its banner without replacing allocation drafts.
  Failed acknowledgements retain the notice; a newer event must not be cleared by
  an older acknowledgement response.
- Manual SO linking remains available before stock decisions or information
  requests are complete, as explicitly required by the clarification in
  `special-po-reference-only-spec.md`. Retain lifecycle, operation and ownership
  guards and the existing authenticated HTTP authorization tests.
- Revoking a decline must recompute the stage from current line decisions. A
  cached pre-edit stage must not hide an unanswered stock check. Price-only edits
  still retain valid stage metadata; transactional and revision guards remain.
- An ambiguous HTTP 503 after a NetSuite record write must not trigger automatic
  write resubmission. Let the owning workflow reconcile its durable marker.
  Read retries and explicit concurrency-limit rejections retain bounded retries.
  Existing lost-response and invisible-marker tests reproduce four POSTs where
  exactly one is required. Failure model: duplicate remote financial records;
  validate via the real HTTP transport and both visible/invisible marker paths.

Further fixture reconciliation: queue metadata includes the conversation event
cursor; regular alert links open the complete actionable list; stock readiness
uses the five supply statuses. Browser fixtures must supply valid item UOM data
and preserve all four packing fields in exact PO payload assertions. Legacy
native-PO recovery starts from an SO already matching its persisted purchase
review; newly created independent POs continue to preserve unrelated SO details.
Vendor pickup evidence alone does not establish NetSuite SO fulfillment/PO receipt.

Further observed regressions and explicit contract amendments:

- One SCM stock-check event must produce one Sales popup, including when the
  current actionable-status projection also labels it `input_required`. Mark the
  matching confirmation notice as displayed without acknowledging the business
  action. Separate PO, arrival and subsequent conversation notices must survive.
  Keep the failing stock-check popup browser assertions unchanged.
- Waiting labels and the request reference must share their vertical center on
  wide cards and wrap without overflow on phones. Keep the existing measured
  two-pixel assertion; repair the newer unified-status CSS alignment.
- Unified filters follow `unified-stock-status-spec.md`: clearing resets four
  active statuses while removing type/vendor restrictions. Long-scroll coverage
  uses synthetic fixtures and tracks visible table text as well as prose.
- The missing-arrival CO negative fixture must still locate the SO at the source
  yard. Completed-arrival fixtures now move it to the destination automatically.
  Preserve active/loading blockers and immutable-history assertions.
- Received TOs are excluded from outbound preparation by the current terminal
  status rule. Listing must not change saved local packing or receipt evidence.
- The BIN pool lists ready unassigned deliveries before a bin is reserved; an
  assignment without available assets must fail atomically. Quote conversion
  creates the requested delivery only. The P3 pilot must request collection
  explicitly through Front Desk after delivery, preserving that requested window
  and idempotency instead of automatically creating/rebasing a return visit.
- Native SO fulfillment now belongs to Operator under migration 301. Consolidated
  loading with its gate enabled must admit the SO fulfillment command; TO posting
  continues to wait for Driver evidence. Exercise the real HTTP admission with
  synthetic NetSuite transport responses and preserve photo/replay assertions.

Correction after tracing the native admission owner: the preceding SO admission
amendment was inaccurate. `sales-delivery-load-fulfillment-spec.md` requires
loading to commit locally with a durable background candidate and no NetSuite
request inside loading. Consolidation forgot to exclude `sales_load_background`
from synchronous posting. Preserve the existing HTTP assertions and repair that
owner filter; TO still waits for Driver and background SO processing retains its
own gate/quantity/idempotency tests. No synthetic remote responses are necessary.

BIN pool refinement: the newer `bin-order-workflow-spec.md` routes fresh orders
through configuration. Unconfigured cards are visible with `configurationRequired`
and are not dispatchable; they do not use the legacy front-leg missing-assets
error. Assert no available choices, rejection of a nonexistent selected bin and
an unchanged visit/service-line snapshot instead of the obsolete card text.

Dispatch clarification: `dispatch-status-independence-spec.md` explicitly
supersedes the Operator activity blocker for dependency links. The CO fixture's
missing/active arrival proof must still block through actual Driver evidence;
SO loaded quantities alone permit the preview and remain unchanged. Likewise
`co-operator-routing-spec.md` routes a source SO to its CO destination even before
arrival, so a source SO and its CO cannot be loaded together at the origin.
The mixed four-order load fixture must use an independent source SO for the CO.

Transfer timing refinement: `transfer-yard-posting.spec.json` and its existing
integration coverage supersede the original waiting-Driver rule for ordinary
yard transfers: physical loading captures `waiting_posting` IF work immediately.
Only linked direct-to-customer transfers retain their Driver dependency. The
mixed-load HTTP check must assert one retained TO snapshot and exactly two SO
background candidates, unchanged across repeated resume calls and no remote read.

Shuffled full-run finding: the real waitlist startup check completes its health
and overdue-allocation assertions, then fails because its evidence directory is
absent. Its tool must create that directory itself; do not depend on another test
having run first. The recorded ENOENT is the red evidence and all business
assertions remain unchanged. Pin the repair runner's comparison to the original
deployed commit so its static/coverage results remain reproducible after commit.
Preserve the login VM source filename and offsets for coverage attribution;
this changes instrumentation metadata only, retaining all login assertions.

Mutation reporting refinement: the property-only invocation must select the
explicit spec reporter and retain its counterexample/assertion evidence. The
prior default TAP output was not classified by a string check for AssertionError.
The fresh property-only replay shrinks the consolidation fault to one Sales
Order with the gate enabled: actual materialized IDs `['1']`, expected `[]`.
This corrects evidence collection without changing the property or implementation.
