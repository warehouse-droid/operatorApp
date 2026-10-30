# Repair acceptance specification

Approved by the user through “Implement the plan” after the reviewed Repair plan.
Tier 3: money, authority, public quote links, stock concurrency and fleet safety.
Use the installed Node/Express/PostgreSQL/PDFKit/web-push toolchain; no new
dependencies or commits. Preserve unrelated workspace changes.

1. Driver MBT, Operator MBBS and office external/MBR intake capture canonical
   equipment, meter unit/value, defect and operating condition. Submission is
   idempotent and creates one inspection; default fee is CAD 150 before tax.
2. Inspection queues one custom WOR and, except MBR internal, one repair SOS.
   NetSuite failure retains the request and retries the same external identity.
3. Office issues versioned line-item quotes. MBT Dispatch, MBBS yard Control,
   MBR Sales and a restricted external customer link are the only approvers.
   Decisions cover every line atomically. Default selections are not approval.
4. Diagnosis is allowed before approval; repair and job purchasing require
   approved scope. Revisions cannot silently authorise changed scope.
5. A rejected quote owes 150; accepted repair scope of 1000 owes 1000 overall.
   If 150 has already been billed, the remaining pre-tax charge is 850.
   Existing billed SOS records require accounting reconciliation, never rewrite.
6. Can Operate gives warnings. Out of Service prevents future planning and new
   starts today, alerts Dispatch, and preserves already-started completion.
   Requesting drivers/operators and technicians may correct condition; office
   cannot. Receiving a declined/unrepaired asset never clears its safety hold.
7. Workshop records inspection/work, actual hours, requested/used/returned parts,
   next steps and photos. Stages include queuing, in progress, waiting for parts
   with ETA (or explicitly unknown), completed and re-inspect; urgent is priority.
8. Completion creates a durable recipient notice. Receipt requires photo.
   Rejection requires reason/photo and reuses the same request and fee. Office
   may delegate internal receipt or record customer name/photo. Cancel is audited.
9. Office approves purchase requests. Completed purchases contain vendor, invoice,
   prices/tax, photos and receipt; only then can a standalone expense Bill post.
   General expenses have no usage ledger. Tracked stock: buy/receive 5, issue 3,
   leave 2; later use/returns do not create another bill. Negative stock is denied.
10. Supplier costs/receipts are office/Admin only. Approvers see quote prices,
    operational viewers see authorised repair records. Attachment downloads,
    searches, public links and notices apply the same authority boundaries.
11. New Vehicle Master registration uses an existing NetSuite customer. Existing
    custom Vehicle/Machine identity is preserved; no standard fixed-asset model.
12. Inspection, quote acceptance, completion, stock moves and external posting
    withstand retries, stale revisions, concurrent commands and partial failure.
13. Existing PWA/history/auth/dispatch/MBR interfaces retain their behavior.
    Feature-off mode does not start posting or manufacture production records.

Failure model: duplicate charges (external IDs/replay tests); stale approvals
(revision/race tests); stock underflow (locked ledger/concurrency/property tests);
unsafe assignment (shared fleet lock/execution tests); data disclosure (HTTP and
public-token adversarial tests); lost evidence (receipt/upload retry tests);
partial posting (worker recovery tests); migration regressions (isolated baseline
and affected/full regression comparison). Record all unverified boundaries.

All execution uses docker/run-isolated-tests.sh and its unique artifact directory,
mbbs-tests.slice and bounded containers. Teardown removes containers, volumes,
networks and generated logs even on failure/interruption. Only this spec and the
concise evidence/operations records survive. No production credentials in tests.

## Equipment clarification — 2026-10-26

The user clarified that the requester selects the equipment and the office or
repair team can correct it, then asked how trucks and forklifts are distinguished.
This extends items 1, 3, 6 and 12 without inferring type from the requester/company:

14. Preserve NetSuite Vehicle Master `custrecord76` as the source type. Recognize
    explicit truck/forklift/loader labels. Placeholders, model names and other
    unrecognized values remain unknown, rather than guessing from plate or owner.
    Show the type with the equipment number. A requester can propose a type for
    office/repair confirmation; creating a request still queues inspection.
15. Internal truck quotes go to Dispatch; forklift/loader quotes go to the
    responsible yard's Control. Unconfirmed/unknown internal types cannot obtain
    quote approval. Existing MBR Sales and outside-customer routing is retained.
16. Office/Admin and repair technicians can correct equipment/type on an open
    request with a reason and current revision. Record original and corrected
    equipment, actor and time; keep the request, inspection fee and inspection
    posting identity. Move only this request's hold, retaining other holds.
    A changed asset requires inspection again; changed equipment/type/yard
    invalidates old quotes and public links. A correction cannot change the
    owning/billing company or bypass formal receipt.
17. Serialize corrections with fleet changes and posting claims. Reject changes
    while a posting is active. If external posting was already attempted for a
    different asset, require office reconciliation before further automatic
    posting; never create a second inspection fee or silently rewrite orders.

This clarification selects equipment on the repair request. It does not add an
equipment assignment to unrelated Operator loading jobs or infer one from the
requester's repair history.

## Portal and requester clarification — 2026-10-27

The user requested these changes directly after deployment:

18. `/repair` is the department jobs portal. Explicit Office and Repair Team
    destinations are available in the shared sidebar to their existing roles.
    Browser cache keys advance with navigation changes.
19. Operator and Driver embed a separate tablet/phone requester screen containing
    new-request intake and their own active/delegated requests with progress.
    It never displays departmental menus, purchases, settings or workshop tools,
    including for a requester who also has Admin authority.
20. The user explicitly selected keeping workshop-completed requests visible
    until formal receipt. Accepted and cancelled requests leave this list;
    rejected receipts remain active for re-inspection. Existing photo, authority,
    idempotency and vehicle-hold requirements continue to apply.
21. Repair Team is an installable tablet/phone PWA. Technicians can start
    inspection/approved work, take original photos, and request parts against
    approved scope. Offline navigation explains that reconnection is required;
    this does not introduce offline writes or cache private job responses.
22. Office searches repair and purchase records, including records with no
    attachments. Opening a result shows that record and its photos/receipts.
    Searching parts matches names and SKUs without losing keyboard focus.

Validation uses the existing disposable runner and dependencies. No role grants,
equipment initialization, NetSuite posting activation or business data repair
is included in this UI release.
# Equipment master clarification — 2026-10-27

23. Equipment lookup automatically refreshes Vehicle Master and Machine Master; existing standalone machines must be searchable by master record number, internal code, name and serial. Matching records share a local identity only when the physical-equipment match is unique. Machine rental customers are not equipment owners. The verified Vehicle Master owner for Mr Bin Building Supply LTD. is customer 7143.
24. Office staff can add a Vehicle Master or an MBR rental Machine Master. Creation writes to that exact NetSuite record type, verifies the saved identity and makes the record immediately searchable. Replays and lost responses must not create duplicates; changed replay content must be rejected. These master writes are separate from financial posting, which stays disabled.
# Repair Team workbench clarification — 2026-10-27

25. `/repair/workshop` uses the Operator visual shell and only Jobs and Parts navigation, including for mixed-role staff. It loads a dedicated Team client without the departmental sidebar or Office client. Tablets show a 30% job-card list and 70% selected-job detail; cards show job number, equipment and priority. Phones show the list and selected details with a clear back action.
26. Technicians start work, enter work notes, take photos, save progress, finish inspection, or complete approved jobs in the detail panel. Completion requires notes and a photo through this Team flow; existing inspection, approval, outstanding-parts and receipt rules remain enforced. Failed uploads retain notes/photos for retry. Switching tabs/jobs preserves unsaved drafts.
27. Parts combines searchable names/SKUs/stock with job-linked purchase requirements and status. Technicians may read these requirements and raise requests through the existing approved-scope workflow. Office retains purchase approval, actual purchase entry and financial access.

Implementation setup: reuse installed browser/test tooling, Operator CSS and the
existing disposable Repair runner. No dependencies or Git commits. Extend the
browser/HTTP acceptance suite, validate the scoped live-image candidate, deploy
and verify health/assets, then remove every task test resource. This clarification
is based on the user's explicit layout/workflow request; additional spec approval:
not obtained (autonomous run).

28. Preserve the existing technician equipment/type correction workflow inside a collapsed job-detail section. It retains the correction reason, original selection, same request identity and re-inspection behavior, without adding navigation tabs.

## Merged office portal and notifications — 2026-10-27

29. Merge the department and Office screens at `/repair`. Old `/repair/office`
    links preserve their query and selected job while opening the merged portal.
    Sidebar and office login have one portal destination; office tools and existing
    role restrictions remain available. The portal is a regular browser page.
    Only `/repair/workshop` advertises the Repair Team installable PWA.
30. All shared notification badges and Repair updates use one persistent top-bar
    group. They retain a consistent order and readable wrapping on desktop, tablet
    and phone, survive view changes and refresh, and keep their existing actions.
    The Repair updates page remains selected during background refresh.

This is the user's requested follow-up UI correction. Reuse the bounded disposable
runner, test the scoped current-live candidate, deploy with rollback, verify
public assets and health, and remove all temporary test resources.


## Normal-flow corrections — 2026-10-27

The user requested this work and clarified that new equipment means registering
new equipment during intake, not a setup/preparation job. Tier 3 applies to stock,
local purchase orders, quote approvals and external-master retry safety. Additional
spec approval: not obtained (autonomous run). Existing dependencies and bounded
Repair runners are reused; no packages or Git commits are added.

31. Office New request offers existing equipment or registering a new Vehicle /
    Machine Master and raising its repair request together. Validate intake before
    a remote write. Preserve separate registration/request command identities
    across retries and retained drafts; a lost response must create one master and
    one repair. Operator/Driver cannot acquire master-creation authority.
32. Boards, job cards, details and requester progress show exactly these workflow
    stages: Queue for Inspection, Wait for Quote, Wait for Approval, Wait for PO,
    Wait for Parts, Queue for Repair, Completed, Closed. Receipt acceptance closes
    the visible workflow; rejection returns it to inspection. Reuse the existing
    stored lifecycle and safety holds, exposing a derived stage without rewriting
    historical statuses or releasing declined-repair restrictions.
33. Office job equipment/type, priority and operating condition share one visible,
    expanded section. Authorized office staff can change condition with an audited
    reason. Existing equipment correction, billing-owner checks and reinspection
    rules remain. Office has no completion form, including for mixed-role users;
    Repair Team completes through its PWA with notes/photos and existing holds.
34. Quote preview and revision use one section. Edit/Cancel toggles editable fields;
    saving retains quote versioning, stale/replay protection and new approval.
    Failed saves keep entered fields. Approval totals and inspection-credit rules
    remain unchanged.
35. Office and technicians can request parts on approved scope. One job section
    contains requests, waiting progress, local POs, ETA, stock use and returns.
    Office issues a numbered local PO against current approved requests with vendor,
    quantities/costs and ETA. Duplicate/stale/concurrent issues cannot over-order;
    technicians and requesters cannot issue POs or view supplier costs. PDF download
    is office-only. A local PO neither creates a NetSuite PO nor queues a Vendor Bill.
36. PO receipt adds stock once and marks requests received only when their quantities
    arrive. ETA can be updated with revision checks. Store a local PO using the
    existing purchase/line records, so later invoice entry, purchase evidence and
    the existing completion/Bill workflow share that same stock receipt identity.
    Block Bill completion before a real invoice and original receipt/photo evidence.
37. Office and technicians can record use/return and edit an existing usage quantity
    or notes with a correction reason. Keep an audit trail and compensating stock
    movements; reject stale edits, negative stock, excess returns and invalid scope.
    Never rewrite supplier invoice values or double-count stock on retries.
38. Preserve the merged non-PWA office portal, stable notification header, Team's
    two-tab 30/70 PWA, focused Operator/Driver embeds, master mappings, permissions,
    financial posting gates and historical records. Deploy only the scoped delta
    over captured live, back up affected Repair tables before migration, verify the
    additive migration transactionally in disposable tests, and remove all test data.

Failure model: duplicate masters/jobs/POs/receipts (boundary and replay/concurrency
checks); incorrect stages (table/property tests); stock underflow or created stock
(ledger/correction properties and concurrent HTTP tests); purchasing without current
approval or leaked supplier costs (role/stale/revised-quote checks); premature bills
(invoice/evidence gates); UI regressions and lost drafts (tablet/phone browsers);
schema regression (transactional rehearsal and rollback). Physical device camera /
notification prompts and actual supplier/NetSuite writes are not used for test data.

Implementation clarification for 32–33: the former assertions that prohibited Office condition corrections are replaced with Office access plus a required reason; unrelated requesters remain denied. Team status assertions now use the requested stage names (inspection finished → Wait for Quote; outstanding request → Wait for PO; work finished → Completed). The notification fixture imports the new app cache version so it refreshes the same live module instance. These are requested behavior updates, not relaxed security or UI assertions.

39. A partial local PO leaves the remaining quantity available for another local PO. The job stays Wait for PO while any requested quantity is unpurchased, then Wait for Parts until all requested quantities arrive. Multiple orders together cannot exceed the requested amount.

40. User clarification: one job can link multiple POs raised at different points in its repair. Earlier received orders remain visible when later parts are requested during repair. Every PO retains its supplier, ETA, receipt quantities and invoice; updating an old order must not replace the current outstanding-parts ETA. PO documents and invoice screens identify their linked repair job.

41. User clarification replaces criterion 32's single eight-stage display with two independent statuses. Request status is Queue for Inspection, Wait for Quote, Wait for Approval, Queue for Repair, Completed or Closed. Parts status is separate: Wait for PO, Wait for Parts, Parts ready or no outstanding request. Parts requests/orders still require an approved quote line. Waiting for parts does not replace the request stage; completion still requires resolution of outstanding parts.

42. A request supports multiple independent quote scopes for additional faults. Additional quotes preserve earlier approvals and purchase links. Each scope has its own revisions, decisions and public link. Revising one scope invalidates only that scope; duplicate line identifiers across active scopes are rejected. All active approved scopes contribute to one job total, with one inspection fee/credit. Completion waits for every active quote decision. Posting aggregates active scopes without duplicating charges or resurrecting superseded lines.

43. Repair Team can report an additional problem with work notes/photos on the existing job. Office is notified and prepares an additional quote. Existing approved work remains usable while new work awaits approval. The office, team and requester views show request status and parts status separately. No live financial/NetSuite records are created by validation.

44. Final user schema clarification supersedes the multiple-scopes-on-one-job model in 42–43: one request owns multiple repair jobs. The first job requires inspection. Reporting another issue does not interrupt the original job; office issuing its quote creates a new repair job atomically. Each job has independent revision, quote revisions/approval, work progress, parts status and multiple POs. The `/repair` listing remains one row per request; its detail contains the jobs. Team lists repair jobs. Parent receipt becomes available only after all jobs and reported issues are resolved. All jobs consolidate under the request's one WOR and one SOS (existing MBR internal-repair routing remains unchanged), and inspection is charged/credited once per request. Existing records migrate to an initial job without losing IDs or history. Unresolved declined jobs retain the parent's operating hold after receipt.

44 validation refinement: the browser waits for physical receipt's Parts ready
state (request status now stays Queue for Repair), then edits recorded usage.
Parent-row and saved-work assertions wait for the asynchronous render rather
than reading before it completes. The migration rehearsal serializes quote JSON
explicitly for PostgreSQL. Additional checks cover concurrent quote replay,
resolved-issue rejection, office-only issue dismissal with a reason, and absence
of parent receipt while an additional child is unfinished.

44 fixture adaptation: requester lists and record-search buttons assert parent
request numbers; the office detail asserts the selected child number within its
job label. Existing receipt fixtures mark both parent and initial child complete.
The same receipt/photo and privacy assertions remain. A new child parts request
opens that child from Team Parts. The start/save browser scenario waits for the
start response to render before entering notes, matching the PWA's busy guard.

44 handover refinement: requester detail is explicitly the parent request, also
for mixed Office/Operator accounts. It aggregates all child progress and keeps
the initial job action revision for receipt, so independently changing child jobs
cannot make a valid handover stale. A multi-job receipt test was observed failing
on the child number before this projection fix; a wrong-revision mutant must
also fail the test.

33/44 compatibility refinement: correcting equipment/type/yard invalidates the
request's old approvals, so affected child jobs (including a completed child)
reopen for approval; changing the actual asset requires inspection again. Office
can prepare a replacement for a superseded quote. `equipment-hierarchy.test.js`
was observed failing first on the completed child state, then on the missing
Prepare quote control, before the respective fixes. No new inspection charge
is created by the correction.

Browser readiness refinement: Team keyboard-entry assertions wait until the
existing aria-busy/inert guard clears after selecting or starting a job. Synthetic
keyboard input could otherwise run while user input is intentionally blocked.
Focus, filtering, draft retention and layout assertions remain unchanged.

45. October 28 requester correction: Operator and Driver Personal History has no embedded Repair panel. A Repair requests button opens a dedicated touch page with New request, Ongoing requests and a return link. Only requests raised by that identity appear, including completed repairs pending receipt. Delegation never grants ordinary requester list/detail/evidence access. Mixed staff authorities are downscoped in this page; their departmental portal retains its legitimate access.
46. Control can view and change internal forklift/loader assignments to active Operators. Dispatch can view and change internal truck assignments to active Drivers. Lists are searchable and include the current assignee and operating hold. Authorization, equipment kind/company, active assignee, stale revision, replay and concurrent assignment checks are enforced on the server. Assignments survive master refresh and have an audit trail. Assignment does not grant access to somebody else's repair request.
47. MBR rental repairs close directly when the Repair Team completes all jobs and resolves reported issues. Internal company forklift/loader and truck repairs remain Completed pending photographed receipt by an Operator or Driver respectively. External requests require customer confirmation through a scoped, expiring, replaceable link after every job is complete; office cannot substitute a customer decision. Customer acceptance/rejection and photo evidence are audited, replays are safe, rejected equipment returns to inspection, and declined repairs retain the operating hold. Public links expose only handover details and cannot access other requests, financial data, quotes, or private attachments.

Setup for 45–47: existing disposable Repair runner, browser, property and mutation tooling; no dependencies, commits or external test writes. Release only this delta over captured live source. Spec approval: not obtained (autonomous run). Confirmation recipient policy is being clarified; requester ownership remains enforced meanwhile.

48. Receipt assignment clarification: default to the requester; Control can reassign forklift/loader receipt to another Operator and Dispatch can reassign truck receipt to another Driver. Criterion 46 is a receipt assignment board for all internal equipment and its open repair requests, not a change to fleet planning allocations. Assignment may be made while equipment is out of service and must never clear that hold. Delegated recipients see a separate, restricted Equipment to receive section, without access to another person’s ongoing request record. Supersedes the assignment hold and master-assignment aspects of 46.
49. A request has exactly one receipt, available only when all its jobs are completed and all reported issues resolved. Partial job completion never enables internal receipt, rental closure, or a customer confirmation link. Acceptance closes the whole request once; another job cannot receive it again.
50. Receipt assignment uses the equipment type confirmed on the repair request. Equipment whose imported master has no type must still appear in Control/Dispatch once its request is classified; the other screen must not expose requests belonging to a different equipment type.

Validation fixture refinement: a repeated full run reproduced a collision between
time/random fake NetSuite IDs in the existing HTTP fixture and repository suite.
Those two fixture generators now allocate distinct synthetic IDs using the
disposable database sequence. All behavioral assertions remain unchanged.

51. Office creates a local job PO directly from approved work, without first
    raising a parts request. Existing Repair Team purchase requests can also be
    selected for a PO. A job retains multiple POs. Track four steps: PO placed;
    all parts physically received by Repair Team (partial receipts supported);
    invoice updated by office; Bill posted to NetSuite. Local POs never create
    a NetSuite PO or item receipt. Invoice/Bill steps cannot bypass full receipt,
    evidence, role, stale/replay, approved-scope or stock-conservation safeguards.
    Technicians receive a cost-free incoming-parts view and cannot access supplier
    invoices or post Bills. A queued/failed Bill is not shown as posted. Direct
    PO parts contribute to job/request parts status and block job completion
    until received. Invoice/Bill processing may continue after repair completion.
52. Equipment, type/yard correction, priority and operating condition are saved
    through one Save on the office job page. Validate and apply the changes
    atomically with one revision guard. Priority-only saves preserve quote
    approvals; changed equipment/type/yard retain the existing reinspection,
    approval invalidation, original-equipment history and posting reconciliation
    safeguards. A reason is required for equipment/condition changes. Expanded
    Cancel request appears immediately before expanded Link existing WOR/SOS,
    which appears immediately before Work history.
53. Images can be previewed inside Repair (office, Team and own requester views)
    without leaving the page or exposing private storage URLs. Existing evidence
    authorization and original byte integrity remain. Preview dialogs close via
    their close action/Escape and release temporary object URLs. Non-image
    documents keep their existing download behavior.

Setup for 51–53: same bounded disposable runner and installed tools; no new
dependencies or commits, no test writes to live NetSuite. No schema change is
planned: local PO lines already support an optional originating parts request.
The user’s four-step clarification supersedes earlier office-request and local
PO receipt-by-office behavior. Spec approval: not obtained (autonomous run).

54. Repair Team can raise a parts request before quotation, using part search
    and optional photos attached to that specific parts request. Approved work
    is not a required/request-form field. The purchase-order approval gate stays
    separate. Parts used has no approved-scope or movement selector; new entries
    are job usage by default. Preserve historical scoped/return entries and stock
    correction safeguards. Unscoped usage does not alter approved quote charges.

Schema refinement for 54: make parts-request quote references optional, allow
job-level usage without a quote-line reference, and add an explicit parts-request
photo association. Preserve existing rows and take a Repair database backup
before applying this additive migration. Parts-request/photo retries must not
duplicate requests or discard unsaved photos. No new dependencies or commits.

55. Preserve original local PO unit costs and tax rates when office records the
    supplier invoice. PO PDFs continue to show the placed order. NetSuite Bills
    use the invoice costs. This protects the separate PO and invoice records.

Validation clarification: the combined-Save test uses the existing API contract:
yard identifiers are PostgreSQL bigint strings, superseded quotes remain in the
record, and audit events are exposed as history. Corrected the new test's initial
assumptions; preservation and invalidation assertions remain explicit.

Preserve the existing Office reconciliation control for linking a Vendor Bill
already present in NetSuite. The new local-PO screen exposes it after parts are
received and the invoice is entered; existing verification and audit rules apply.

56. Operator and Driver repair requests use their PWA design: familiar header,
    large touch controls, phone navigation and tablet request-list/detail layout.
    Keep only new requests, own ongoing requests and assigned receipt; preserve
    privacy, one request/receipt and safe retries. Keep the original generic
    requester design and office workflow separate for later staff use. Navigation
    stays within the corresponding installed PWA scope.
57. Operator intake permits only forklifts/loaders and fixes the meter to hours.
    Known truck/other masters cannot be relabelled to bypass this rule. Unknown
    masters can be reported as forklift/loader pending office confirmation. Apply
    server validation as well as UI filtering, preserving Office's wider access.
    Driver PWA intake offers truck equipment with kilometre readings.
58. Requester photo controls are Camera buttons. Android opens native camera;
    Windows uses a live camera, capture, switch and close controls. Captures can
    be previewed/removed before submission. Stop every camera track on close,
    navigation and cancellation, including late permission responses. Keep photos
    and command identity after errors; no false receipt without photo evidence.
59. Find equipment is beside its input at phone and tablet widths. Office existing
    equipment uses one searchable results picker instead of a duplicate dropdown;
    keep master selection, registration and correction metadata intact.
60. Opening Repair must not wait for NetSuite equipment refreshes. Show the
    request board first, fetch optional catalogs when needed, and serve cached
    local master search while a single background refresh runs. Explicit Office
    sync remains available and awaited. Concurrent searches coalesce refreshes,
    and background failures do not discard existing local master records.

Setup: existing bounded disposable runner, Chromium, property/mutation tooling.
No new dependencies, no commits, no new database migration or live NetSuite test
writes. Scope the release over captured live. Spec approval: not obtained
(autonomous run). Failure model adds equipment-type/unit spoofing, lost camera
photos/replayed submits, camera track leaks, offline fallback into the wrong PWA
screen, and master-refresh latency/failure; use API, fake-camera browser, property,
worker/cache contract and delayed-boundary tests for these cases.

61. On the Office `/repair` portal, unrelated department alerts do not appear or
    poll. Repair's unread attention count and popup consider only newly approved
    repair quote updates (including partially approved work); declined decisions
    and other events remain in activity history. Preserve other portals' alerts
    and the Repair Team/requester notification workflows.

Compatibility fixture refinement: positive Operator intake fixtures now identify
forklifts and use hours; truck/km reporting is covered by explicit rejection
checks. Browser steps use the new search picker and role-specific meter labels.
Navigation checks use /operator/repair and /driver/repair within PWA scopes.
Office header assertions keep the repair/preferences controls and require absence
of unrelated alert controls, superseding the earlier all-departments header spec.

Directory test refinement: import/merge scenarios explicitly await Office sync
before asserting newly imported records. Concurrent syncs still coalesce; the new
blocked-remote test covers concurrent cached searches and background refresh.
The camera/replay checks exposed and fixed a stale dialog-close race and a lost
command identity after reload. The replay check waits for completion before
counting records, preventing an early false-positive assertion.

62. Office request detail has a clear Add purchase order button in Parts, purchase
    orders & usage. Show it for an open job even when approval is pending; explain
    and disable placement until approved work exists. Opening the button reveals
    the local PO form with outstanding Team parts selected. Placement, multiple
    POs, ETA/receiving/invoice/Bill sequence and approval safeguards remain.
63. Control has a Repair approvals queue, with a pending count, for classified
    company forklifts/loaders in the manager's assigned yards. List each pending
    job quote independently under its parent request, including equipment, scope,
    quantities, prices, taxes and totals. Review/approve/decline lines directly in
    Control using the existing audited decision endpoint; keep receipt assignment
    separate. Other-yard, truck, rental, external, superseded and decided quotes
    are excluded. Requester, Office-only and Technician roles cannot access this
    approval queue; existing Yard Manager authority is required.
64. The queue and office PO UI must handle quote changes safely, preserve pending
    work on other jobs, avoid double decisions or purchases on retry, and keep
    Operator/Driver privacy. Deployment must not approve the user's live quotes
    or create a live PO; the live REP-0000002 request remains for human action.

Setup for 62–64: existing bounded disposable Repair runner and installed tooling,
no dependencies, commits or schema changes. Spec approval: not obtained
(autonomous run). Failure model: hidden or wrongly routed approvals, cross-yard
financial disclosure, stale-quote approval, bypassing purchasing approval, and
multiple-job/PO replay errors; exercise real repository/API and browser flows.

65. Approval accepts or rejects the entire job quote in Control, Repair and the
    customer link. Show the quote lines read-only and offer Accept quote / Reject
    quote, with an optional shared reason. Uniform legacy line decisions remain
    supported; mixed approvals are rejected by the server before any write.
    This supersedes earlier per-line approval and partial-approval scenarios.
66. Rejecting the whole quote resolves that job with a declined outcome and an
    audited completion; hide it from the Repair Team list and a stale Team job
    selection. Preserve Office history, other jobs' approvals and work, one
    request receipt after every job is resolved, and the unrepaired equipment
    hold. Do not require the Team to complete a rejected job manually.
67. In Team Parts, tapping a purchase-request card opens that request's receiving
    details in place. Show only its linked PO lines, quantities and ETAs; allow
    partial receipts and multiple POs, and refresh the request/stock/job status.
    Waiting-for-PO requests explain that receiving starts after Office orders.
    Preserve quantities and command identity after errors; retry cannot receive
    twice, cross-receive another request, exceed a PO quantity or post a Bill.
68. At the user's explicit instruction, normalize the existing mixed decision on
    REP-0000002-J02 (quote b20bda41-3240-4b62-904e-98d3e6099c08) to full rejection.
    Require an administrative, guarded, idempotent maintenance command; preserve
    the prior decisions and reason in the audit. Refuse a different target or
    downstream repair work, parts usage, purchases or non-inspection posting.
    Do not change J01, issue a PO, post to NetSuite or grant additional access.

Setup for 65–68: reuse the bounded disposable runner and existing browser,
property, coverage and mutation tools. No new dependencies, commits or database
migration. Spec approval: not obtained (autonomous run). Failure model includes
mixed-decision bypass through older clients, stale/double decisions, a hidden
rejected job blocking parent receipt, incorrect PO/request mapping, lost or
duplicated parts receipts, and an unsafe historical correction. Exercise real
repository/HTTP/browser flows and a guarded isolated correction before applying
the specific authorized production correction. The old per-line UI assertions
and partial-acceptance cases will be replaced by explicit whole-quote cases;
authority, cost, scope, replay and receipt safeguards remain.

68a. The user reaffirmed that all of J02 should be rejected and explicitly
     authorized updating the data directly while the UI release is finishing.
     Apply a host-admin maintenance transaction with the same target/downstream
     guards, the existing job-save/parent-rollup logic, original rejection reason,
     before/after audit and an idempotent operation marker. Verify the other job,
     its quote and the posting settings are unchanged inside the transaction.

69. Local PO placement and parts receiving must not wait for the shared Dispatch
    mutation lock or unrelated board/catalog refreshes. Maintain per-request
    serialization, purchase/stock row locks, revision checks and command replay.
    Show a pending state immediately and show success only after local commit;
    update the affected cards directly and refresh wider lists in the background.
    Test with the Dispatch lock and refresh endpoints deliberately blocked.
70. Start Job unlocks work notes, work photos, inspection/repair completion and
    actual-hours updates. Enforce the active phase on the server as well as UI;
    spoofed work/photo calls must fail before saving. Inspection and repair have
    separate starts. Previously active jobs remain usable; quote/equipment
    corrections clear the prior start when fresh inspection/approval is needed.
    Existing work remains auditable, and parts requisitions can still precede a
    quote. Completed, cancelled and rejected jobs are absent from Team Jobs and
    stale direct selections. Completion returns to the next active job safely.
71. NetSuite posting is manual only, even when an old automatic-posting setting
    is enabled. Background processing may deliver notifications but must never
    drain financial posting tasks. Preserve the financial enable/mapping gates,
    authority, duplicate/uncertain-outcome protections and one WOR/SOS per request.
    No live financial posts are part of validation or deployment.
72. WOR, SOS and Vendor Bill are separate explicit Office actions. WOR records
    actual technicians/hours and parts actually used; SOS uses approved quote
    selling quantities/prices; Bill uses the PO supplier invoice quantities/costs.
    SOS links to WOR with custbody14 and WOR links to SOS with custrecord_wo_so.
    A completed repair posts completed inspection/work, with SOS awaiting billing;
    posting/retry never invents an invoice or silently changes a different record.
73. Office shows an accurate Ready state after each document's prerequisites are
    complete, with specific blockers otherwise, and a per-PO status on request
    listings/details. Local work completion, receipt, invoice readiness and actual
    NetSuite posting are distinct. Never label an unposted record Posted/Done.
74. Quote and PO PDFs use a consistent designed Letter layout: branded masthead,
    document number/date/status, recipient/equipment/job information, aligned
    quantity/rate/tax/amount columns, readable totals and terms, continuation
    headers/footers and safe page breaks. Long descriptions and multi-page orders
    must not overlap or lose rows. PO uses original ordered prices after invoice
    changes; quote totals/inspection credit and whole-quote decisions remain exact.

Setup for 69–74: existing bounded disposable runner, PDFKit, Chromium, existing
property/coverage/mutation tools and available PDF rendering utilities. Persist
focused test/benchmark and reproducible release tools; no new runtime dependency
or Git commit. Spec approval: not obtained (autonomous run). Failure model adds
fleet/parts lock ordering, stale stock/PO replays, lost-response refresh coupling,
work/photo phase bypass, incorrect readiness, accidental background financial
writes, mixing actual cost with quoted selling values, broken reciprocal links,
and PDF overflow or mismatched totals. Prior fixtures must explicitly Start Job;
earlier pre-start work/completion and completed-Team-list assertions are superseded.

PDF validation setup refinement: add Poppler utilities only to a disposable test
image based on the existing E2E image, to extract text and render the actual PDFs
for layout inspection. Record the utility version, keep production dependencies
unchanged, and remove the task-specific test image and generated previews after
the complete run. WOR status IDs were verified read-only in NetSuite: 1 Open,
4 Completed, 5 Closed. A completed work post must use 4, with billing handled
separately; the existing reciprocal link fields were confirmed in the adapter.

75. Repair Office can adjust the actual technician, actual hours and actual
    hourly labour cost for each recorded work entry before WOR posting. Require
    a reason, retain original actor/notes and before/after values in the audit,
    reject stale edits and prevent edits during a WOR post or after it is posted
    until reconciliation. These changes must not alter any approved quote or SOS
    selling values. Verify the Office form, authority, replay and posting locks.
    NetSuite read-only schema confirms workforce fields 152 Actual Hours,
    153 Work Notes, 154 Completed, 156 Billable Hours and 157 Hourly Rate.

75a. Actual hourly labour cost is Office/Admin data. Team, requester and quote
     approver work-history responses must exclude it from both work entries and
     correction before/after audit values. Quote approval still sees its selling
     prices, and Office/WOR posting retains the original actual costs.
70a. A stale rejected/completed job link on a phone must return to the visible
     job list and clear the invalid selection URL, even when the detail renderer
     independently suppresses closed work.

76. Quote approval policy has three independent boolean settings: trucks,
    forklifts/loaders, and external customers. All default off when absent.
    External ownership takes precedence over physical equipment type. Internal
    rental equipment follows its confirmed truck/forklift/loader category;
    unclassified/other equipment remains on its existing manual approval route.
77. Admin may change the policy in Repair Settings; Office can view it. Validate
    strict booleans and known keys, preserve unrelated settings, reject stale
    writes, and audit previous/current values and actor. Office/Team/requester
    cannot bypass approval by changing a submitted quote body.
78. Evaluate the persisted policy in the same transaction as issuing an initial,
    additional or revised quote. A matching enabled policy accepts the whole
    quote, records a distinct automatic decider plus policy revision/issuing
    actor in audit, marks the job approved, sends approved notifications once,
    and omits pending-approval notifications/queue entries. Replays do not add
    duplicate quotes, decisions, jobs or notifications. Inspection, equipment
    verification, amount validation and Start Job remain required.
79. Changing settings never changes an existing pending, approved or rejected
    quote. A new revision uses the current policy and invalidates an older
    customer link. External automatic approval is labelled as policy approval,
    rather than customer confirmation. Receipt still follows the existing
    company/customer rules, and NetSuite posting stays manual and gated.
80. Show the three switches in Repair Settings with their saved values, admin
    editing access and prospective scope. Show auto-approved quotes distinctly
    in the Office preview, history and PDF. Preserve independent jobs, request
    listings, actual labour privacy, original whole-quote rules and one receipt.

Setup for 76–80: existing Tier 3 verification workflow, disposable bounded runner,
PDF rendering test image rebuilt from its existing Dockerfile, no new runtime
or development dependency, no Git commit. Spec approval: not obtained (autonomous
run). Failure model: category overlap, unconfirmed/spoofed equipment, approval
privilege escalation, truthy malformed flags, policy/write races, retroactive
approval, duplicate command replay, lost customer-link revocation, false customer
attribution, automatic Start/receipt/financial posting. Catch with real repository
and HTTP/browser flows, role/category matrices, strict-input and replay cases,
seeded properties, targeted fault mutations and the existing full regressions.
