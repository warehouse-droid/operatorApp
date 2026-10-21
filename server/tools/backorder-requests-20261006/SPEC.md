# Regular Backorder requests

Approval: obtained. The user approved the Backorder plan and instructed “Implement the plan.”
Calibration: old-coder Tier 3 (shared purchasing, permissions, concurrency and schema).

## Executable acceptance criteria

1. Regular Type includes Backorder. Create with no customer and two selected regular inventory SKUs; each quantity/UOM follows Regular rules and shortages never block. Persist Regular parent, workflow v2, STREQ reference, workflow discriminator and selected SKU identities. Reject unknown SKUs and ancillary PALLET / delivery-fee inputs.
2. SCM reviews supply status, ETA, private cost and note per material. Sales confirms each response; revised responses invalidate earlier confirmations. Preserve Special notes, quote prices, discounts, reminders and the three fulfillment methods.
3. Sales manually links one SO and SCM manually links one PO at request level. Unique existing synced reference only; reject unknown/ambiguous references and forged identities. Accept different items, quantities, customer, vendor, yard and closed/unapproved status. Several Backorders may share an order. Existing Special exclusivity survives.
4. An SO alone, a PO alone, or absent stock-transfer lines never imply completion. Both links precede fulfillment completion. Read linked order/Dispatch/pickup statuses for tracking; keep per-material readiness and ETA.
5. Changes, cancellation and closure update this request only. Never create, edit, allocate, cancel or close NetSuite orders. Handcrafted Special, Regular transfer/proposal, generation and remote-review requests cannot bypass persisted workflow capabilities.
6. Generic active Backorders appear in Regular Pending / SCM Request, completed or cancelled in Completed / Closed. A Backorder filter offers case stages rather than TO queues. Search SKU, request, customer, vendor, SO and PO; preserve authorized yard scope, private projections, revisions and line ownership.
7. Existing Special and Stocking behavior survives; additive schema accepts old records. Quote/form/review has no PALLET ancillary or delivery-fee row, and optional customer works. Native material PLT units are allowed.

## Setup

Use existing Node, PostgreSQL, Playwright, fast-check, c8, TypeScript and ESLint from the cached test image; no dependencies or credentials added. Preserve this dirty Git tree; no init, reset or commit. Add task tests, reproducible runner, SPEC and EVIDENCE under server/tools and server/test-artifacts. Capture baseline before implementation. Register teardown before tests, use standard bounded disposable Compose in mbbs-tests.slice and remove every test container, volume and unused network. Keep logs. Deploy only verified changes over the current production image, rehearse migration/rollback, retain operational rollback evidence and verify health and packaged imports.

## Failure model and required evidence

- Accidental financial writes: trap network adapters, hostile route tests, persisted capability guard tests.
- Data loss / failed migration: upgrade old schema and rollback rehearsal, old-record compatibility and immutable SKU/profile constraints.
- Cross-case / cross-yard exposure: real HTTP roles, unauthorized yards, foreign line IDs, recursive private-field tests.
- Stale edits / concurrent linking: revision conflict and parallel link tests, transaction rollback.
- Premature completion / wrong queue: SO-only, PO-only, no transfer rows, real Dispatch/pickup observations and SQL/JS stage agreement.
- Shared-reference ownership regression: two Backorders share, two Specials cannot.
- Broken packaged deployment / UI: browser create-review-confirm-link cycle, generated quote, packaged module import and live asset/health checks.
- Weak tests: RED assertions, properties and at least five plausible mutants, property-only reruns for applicable mutants, changed-line coverage, fresh baseline/candidate static checks and reversed suite order.

## Visible test refinements

The browser waits for the committed material summary, rather than a supply dropdown option already displaying “In stock.” This strengthens the existing confirmation check and prevents a test from entering the next form during a pending save. The shortage-independent creation criterion also verifies that Backorder item selection does not invoke the live availability-refresh route; synced catalog selection is sufficient. Assertions were changed separately from implementation, then observed RED before the picker change.

The committed review status is the second material summary paragraph; the first contains quantity. The targeted browser wait was corrected accordingly without changing its expected status.

Backorder notifications must not interrupt work with a popup for the same request already being viewed. The Regular badge and other-request notifications remain available. A real-browser failure reproduced the popup blocking the next manual-link action; the browser now explicitly checks this condition before continuing.

A pending local Backorder save must preserve a different request selected while the response is in flight. A browser test delays a real HTTP response, switches requests, and checks both the selected view and the saved database row. This is an explicit concurrency refinement of the revision/identity failure model.

The navigation test checks every rendered request identity after releasing the response, as well as the final view. The first version passed because a refresh restored the second request; observing intermediate rendering makes the required identity invariant precise.

The worker currently runs older Special source than the web app. Deploy only the webhook selector's persisted-profile predicate to the worker. Test its existing source plus that single change against real shared Backorder references; exclude them from Special reconciliation and verify no case mutation or outbound request. Preserve all other worker source and dependencies.

Preserved quote pricing includes local material price and sales-discount edits after manual linking. The edits update the request's quote, preserve the other material's price, invalidate the edited material's confirmations, and never change the linked NetSuite order. Existing money bounds apply.

The PDF test decodes the binary response prefix explicitly through Buffer before comparing it with `%PDF-`, and saves the actual bytes. The expected five-byte PDF signature is unchanged; the binary response's JavaScript byte-array type is logged.

Manual links can precede the material reviews. SCM notifications must still count incomplete reviews, and Sales notifications must still contain revised material confirmations after those links. Notification eligibility therefore also checks material state independently of the order-tracking stage; terminal cases stay excluded.

PDF diagnostics showed Chromium's response observer returning zero bytes for an inline PDF with Content-Length 19,914, while the real HTTP response contained the full PDF. The test now reads the actual Blob passed to the browser preview and verifies the same `%PDF-` signature plus byte length equality with HTTP. This preserves the byte-output requirement and tests the data used by the preview itself.

The adversarial pass also checks exact persisted-profile errors from generic edit/cancel/line-decision APIs, database records unchanged on rejection, terminal SCM review rejection, mirrored directory/reference filtering and Special alert separation. Browser checks now cover case-stage filters in both roles and continued review with the saved vendor during a vendor-directory outage. These are regression armor for existing approved access, queue and review invariants; applicable throwaway mutants must fail them.

The multi-yard browser fixture now authorizes both selected yards, so its destination selector can exercise an actual permitted change. The Backorder queue requirement means the legacy TO queue controls are hidden from users; the browser asserts the queue tablist is hidden rather than demanding absent DOM nodes. These corrections were made separately from implementation after inspecting the real disabled selector and hidden tablist.

The corrected browser visibility check exposed a real CSS bug: the tablist's flex display overrode HTML's hidden attribute. Add a scoped hidden-tablist rule so Backorder visibly replaces the legacy TO queues; retain the failing visibility assertion unchanged for GREEN.

A read-only catalog check found native Regular UOM labels such as `Ton` and numeric `889`. Backorders must preserve the catalog label and use the existing Regular quantity-conversion rules without adding the Special UOM character format. New assertions exercise numeric native labels, exact mixed-case labels with PLT conversion, and rejection of direct quantity when that catalog item has conversion fields.

The latest read-only STREQ-000082 check shows users have progressed the other lines since the earlier repair: revision 7, line 166 rejected, line 167 locally resolved with POB03658, and line 168 still submitted. Do not restore stale states. Live verification preserves line 165's POB03992/2026-10-08 association, validates the four line identities and reports the current states; the migration separately proves existing request rows are unchanged within its transaction.

The full comparison observed a new failure in the unchanged destination-yard UI contract: evaluating the Regular script tried to initialize the Backorder module before the normal authenticated page startup callback. Defer that import until the existing startup callback, preserving the destination contract and exercising initialization through both real-browser roles. Keep the original assertion unchanged; preserve the failing candidate log as RED.

The first mutation run caught 17 bugs but a chosen queue-assignment mutation survived: the backend also derives the terminal bucket from an explicit Backorder stage, so that mutation did not remove the stage filtering. Replace it with the actual bug of omitting the stage parameter. The browser now contains both a completed and a closed Backorder and verifies each terminal stage excludes the other case. Preserve the initial survivor log and claim only the final fresh mutation results.

The final coverage audit initially reported an unexecuted generic Regular guard. Its recorded regression coverage showed 49 executions, but combining reports by source path overwrote that result with later Special suites' zero counts. Preserve each report separately when checking executions and reporting branches. Keep the original failing audit log, change no application code or behavioral assertions, and rerun the final gauntlet with the corrected collector.

Screenshot inspection found the shared order-status display telling Backorder users that the request waits for NetSuite PO approval. Manual Backorder links bypass that business check and fulfillment is already permitted, so the message is misleading. Browser assertions in both roles must reject the inherited approval notice after linking a closed/unapproved PO. Add an explicit presentation option to suppress this notice for Backorder while retaining existing Special display behavior; include the shared display helper in the narrow deployment delta and a mutant that restores the misleading notice.
