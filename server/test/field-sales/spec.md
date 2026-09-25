# Field Sales executable specification

Approved: the proposed plan in the conversation, followed by “Implement the plan.”
Assurance: old-coder Tier 3. Existing work is preserved; no commits or production deployment are part of this change.

## Failure model and acceptance map

- Incorrect money: quantities and rates use decimal strings, line amounts and company taxes round half-up to cents. Shared client/server calculations and property tests verify company totals sum to the combined total.
- Unauthorized access: only field_sales/admin can enter; route ownership is enforced server-side. Staff Sales/public Sales never grants access.
- Lost work: import staging is committed only after complete pagination; annotations survive refresh; absent records are marked unseen, not deleted. Offline commands/photos remain durable until acknowledged.
- Duplicate work: source keys, command UUIDs, photo hashes, quote revision/company jobs and remote external IDs are unique. A repeated command with different content fails.
- Concurrent/stale work: route and quote base revisions are checked; completed stops preserve visit evidence; conflicting drafts remain on device.
- Partial remote work: preflight both company payloads; retain one result per company; reconcile uncertain outcomes before retry; an older revision cannot overwrite a newer one.
- False construction evidence: preserve source statuses/dates and distinguish address-matched permits from verified project activity. No permit-age cutoff.
- UI failure: exercise desktop and phone layouts, offline reload, manual stop insertion, route optimization preview/apply, notes/photos/follow-ups and quote/PDF flows through HTTP and browser checks.
- Regression: record the existing MBT baseline and verify no new failures in the complete suite; smoke existing authentication, Driver, Sales and MBT entrypoints.

## Concrete scenarios

1. Community Planning/Open import crosses a 2,000-record page boundary, detects incomplete/duplicate pages, retains all wards, and imports again without duplicate sites or erased notes.
2. A multi-address application remains one application with address aliases; an older permit at the same address is address evidence, not proof the new project started.
3. Toronto afternoon plans use 13:00–17:00 local time, including winter/summer UTC offsets. Two areas and multiple routes can be planned for one date.
4. Rep A cannot modify Rep B's route; admin can reassign it. A duplicate offline visit UUID returns the original result without another visit/follow-up.
5. A route, unplanned jobsite, photo and quote draft survive a disconnected browser reload. Reconnection applies dependencies in order exactly once; stale edits remain reviewable.
6. MBBS 3 × 19.99 plus MBT 2 × 100 at configured 13% tax yields company totals 67.77 and 226.00 and combined 293.77. Hostile numeric input and unsafe magnitudes fail.
7. A mixed quote creates two linked estimates; republishing changes the same IDs. Failure of MBT leaves MBBS acknowledged and retries only MBT. Timeout after create reconciles by stable external ID.
8. A local prospect saves/downloads drafts but cannot publish before customer/subsidiary mapping. Removing one previously posted company closes its estimate. External edits/converted records block overwrite.
9. Combined and company PDFs contain one immutable revision, exact totals, jobsite/customer and draft identification.

## Setup

Use existing Node test, fast-check, Playwright, ESLint, TypeScript and c8 tools in an isolated Docker runner with a dedicated PostgreSQL database. Add pdfkit 0.20.2 (MIT) for server-generated PDFs. New migrations are additive. Field Sales posting requires both environment and admin configuration gates; no live credentials are used by tests. Persist a reproducible gauntlet and evidence report; record unavailable external sandbox validation explicitly.

## Implementation clarifications and test corrections

- Migration 210 follows a concurrently added, unrelated migration 209.
- Suggested route order uses geographic nearest-neighbour / two-opt; the separate road estimate uses the shared, metered Maps gateway. The user applies the proposal explicitly.
- MBBS suggestions read the CAD base price and first quantity tier from the NetSuite pricing matrix. MBT suggestions use configured active rate versions; selections and manual rates are audited. Account-specific price/tax sourcing must be verified in the sandbox.
- A PDF's compressed byte count is not an acceptance criterion. The first PDF test incorrectly required more than 2,000 bytes; replace that assertion with stronger extraction checks for exact amounts, company separation, customer/site, revision, and draft status. No product behavior changes.
- Live address data uses the municipality name `former Toronto`. Strip the `former` prefix before district mapping. Unlocated permit records retain distinct identities and an explicit unavailable-address label.
- Browser database assertions wait for the visible "All changes saved" acknowledgement; offline-first writes intentionally return before server synchronization. The stop count assertion remains exactly two.
- Migration rehearsal covers the actual 18 new tables. Its first fixture mistakenly expected 17, corrected after inspecting the migration; rollback must still preserve the exact pre-rehearsal operator count, quote count and settings.
- NetSuite sales units are checked before publication; a stock-unit label must not silently select a different sales unit. Refreshing a suggested MBT price also reads its NetSuite sales unit when the integration is available. PDF unit rates retain up to six decimals; line and tax amounts remain cents.
- Final regression comparison must compare individual failed assertions as well as failed files. The first file-only comparison missed two stale assertions inside files that already had unrelated failures: the frozen dependency inventory omitted the explicitly planned `pdfkit: 0.20.2`, and the admin sidebar inventory omitted the requested Field Sales module. Update those exact inventories, preserve all other expectations, and add Field Sales-only and secondary-role navigation cases.
- The dependency license check must inspect packaged license files when package metadata omits the license. The first check incorrectly rejected Microsoft's `tslib` 0BSD license and `png-js`'s packaged MIT `LICENSE`; retain exact version/license evidence and fail for unknown licenses rather than treating missing metadata as conclusive.

## 2026-09-18 follow-up: ward names and map selection

Tier 2, frontend-only follow-up. Spec approval: not obtained (autonomous run).
Use the existing pinned Docker/Playwright/PostgreSQL tools; add no dependencies, migrations, commits or production test records. Preserve the unrelated dirty workspace. Deploy a scoped overlay on the active release, retaining rollback and verifying unchanged service configuration.

- Display all 25 named wards (for example, `01 · Etobicoke North`) in the filter and site editor, and show the name in list/detail views. Ward numbers remain the existing API values. Names come from the imported City planning snapshot.
- Map idle after pan/zoom automatically queries the visible rectangle for both list and markers. Pagination and filters keep the existing map and route form. Changing the rectangle/filter resets pagination and selection; late responses cannot replace newer results. Failed loads clearly indicate failure and disable selection of stale results. Without a map, ordinary filters still work.
- Each visible result can be selected. `Select all` selects every matching result in the current rectangle, including later pages. `Add selected to route` saves one route command, keeps existing stops/details, skips an identical jobsite/address already on the route, and clears selection after success. Select a route first; do not create a blank route implicitly from bulk selection.
- The existing 250-stop route limit applies to the combined route. Reject an oversized batch before saving, without a partial addition. Fetch at most the bounded selection size, fail without changing the route on incomplete/failed results, and stop a pending selection if the map/filter changes. Existing authorization, revision conflicts and offline command persistence continue to use the established route command path.
- Verify names, automatic viewport changes, paging, combined filters, empty results, stale responses, preserved route edits, selection across pages, duplicate/completed-stop preservation, failed/oversized batches and unavailable-map fallback in real Chromium against real HTTP/PostgreSQL. Simulate only the external Google Maps SDK/session boundary; no paid Maps request is needed.

Follow-up test fixture corrections: the first bulk RED used an unconfigured “No contact” outcome; it was corrected to the configured “Contact unavailable”. Two later browser fixtures created routes after the page loaded, so the test now opens those routes through the existing Routes screen before asserting bulk behavior. No acceptance assertion was relaxed.

Browser save synchronization correction: wait for the bulk action to finish enqueueing (selection cleared), then for the existing sync indicator, before reading the database. Checking the idle indicator immediately after the click could precede the asynchronous route load and incorrectly inspect the previous revision.

Additional acceptance: 204 matching jobsites must select across both API pages; a 259-jobsite area must ask for a smaller selection. Incomplete API pages and a map move during selection must leave the selection empty. Property tests cover complete, ordered, idempotent additions and the exact 250-stop boundary.

Mutation harness correction: rejecting an otherwise valid 250-stop route raises the production validation Error, which correctly fails the acceptance test. The harness now requires the exact expected failing subtest for each mutant instead of incorrectly requiring every failure to be a Node AssertionError. Syntax/import errors still cannot count as kills.

## 2026-09-19 recent construction leads

The user approved the proposed plan with “Implement the plan.” Default recency: 12 months; target homes and larger construction. Use the existing evidence-first checks (Tier 2 for this read/filter change), isolated PostgreSQL 18 and pinned browser/test tooling. No new dependencies, schema migration, production test writes or Git commits. Deploy only the verified module changes over the image live at preparation and retain rollback.

- Add 6/12/24-month and All ages choices, default 12 months in the planner. API requests that omit recency retain unrestricted dates. A cutoff is inclusive and uses Toronto calendar days, clamping month ends. Invalid/missing dates fail dated filtering, but remain available in All ages. Permit date = valid issued date, else application date, else legacy normalized source date; planning date = latest milestone date. Import times never affect eligibility or sorting. Dates supplied by the City as date-only/midnight ISO values retain their calendar date.
- Hide existing mechanical/plumbing/fire/security/sign/alternative-solution permits and structured work labels for backwater valves, signs, solar collectors, party-wall administration, change-of-use-only and window-only repairs. Hide standalone Inside and Outside Drains within Drain and Site Service; retain building-related drainage, site service and drainage in a conditional building permit. Do not inspect description keywords to exclude otherwise valid construction. Keep unfamiliar work with a review label; Include minor/service work restores excluded work.
- A single present source record must satisfy source, status, milestone, category, work and age conditions. A 2022 construction permit plus a recent plumbing permit must not appear in default construction leads; nor may independent permits each satisfy only one filter. List/map/count/Select all use the same conditions. Order by rep priority, matching source date descending, readiness rank and stable ID. Display the exact qualifying record and label its issue/application/milestone date; rename Seen to Last imported.
- Selecting a milestone sets Planning applications and clears permit status; selecting a permit status sets Active permits and clears milestone. Preserve age and map area. Reset restores Recommended + 12 months and clears selection. Exact City milestone names include Notice of Complete Application Issued. Show the active age/work/map constraints, particularly for empty results.
- Manual jobsites have no City date restriction. All jobsites includes manual records; All ages retains records with missing source dates. Existing detail/route/history endpoints and importer retention remain unchanged.
- Regression fixture 22 127851 DRN at 276 PRINCE EDWARD DR S (issued 2022-04-12, Back Water Valve, Inspection) is excluded by default and found with All ages + Include minor/service work. Recent structural jobs and complete-application planning records remain searchable. Test date edges, malformed inputs, same-record matching, labels/order, map/list/paging/bulk consistency, saved records, old offline/mobile flows, SQL/JS policy parity and City-scale read performance.

Recent-leads verification notes: the first database RED failed six new regressions; existing detail retention already passed and was subsequently proved sensitive with a throwaway history-filter mutant. The UI RED failed on missing recency controls. The later SQL/JS policy checks were proved sensitive individually by four named mutants. The first history mutant had incorrect JavaScript quoting; the harness rejected that syntax failure rather than counting a kill. Correcting its escaping changed no acceptance assertion. A lint-only local variable shadow was renamed. City-scale read evidence justified replacing repeated correlated checks with materialized candidate/matching-source sets; all behavioral assertions remained unchanged.
