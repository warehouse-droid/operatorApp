# Regular stock requests v2 — approved executable specification

Spec approval: obtained through the implementation plan and “Implement the plan”.
Tier 3: inventory decisions, external orders, concurrent retries, purchasing and private Sales alerts.

## Acceptance

1. Optional customer; mandatory pickup/delivery and Toronto arrival date/time. Normalize ISO/M/D/YYYY and 12/24-hour text; reject impossible or ambiguous local times.
2. Auto approval requires every aggregated item/source balance after shipment >= Smart SCM safety stock and arrival >= configured lead hours after submission. Default 5; zero disables the lead restriction. Missing evidence routes to review.
3. Show safety, available, requested, remaining and shortage per line. No local stock holds; retain approval despite later inventory/time/settings changes.
4. SCM decides each line: stock, source replenishment PO, or rejection with reason. Sales supplies an SO after all decisions. All rejected closes the case.
5. Match open SO material lines and quantities at Sales' ordering yard. A completely covered single external source changes line locations; additional local SO material or multiple sources creates one real TO per source to Sales' yard.
6. Retry remote work by persisted identity/marker, verify writes, never duplicate orders, link TO dependencies and retry printing independently.
7. PO approval waits for SO execution and fresh post-commitment NetSuite inventory. Target Smart SCM preferred minus eligible inventory position; never subtract request quantity twice.
8. One persistent replenishment group per item/source, all request references, separate priority PO load, pauses bypassed only for this demand. Credit priority quantity against ordinary planning. Recalculate drafts, never rewrite placed orders, carry until explicit release. Covered zero gaps stay visible.
9. SCM pending-review count; requester-only unread manual decisions, including partial/rejected cases. Persist read position, never acknowledge newer unseen decisions; use SSE plus polling, English/Chinese, role/yard checks.
10. New workflow is versioned. Preserve legacy requests, special requests, existing permissions, receiving, dispatch and printer behavior; no production orders in tests.

## Failure model / verification

- Wrong safety/time boundaries, UOM and duplicate demand: unit, property and mutation tests.
- Duplicate or partial remote execution, concurrent decisions/release: transaction/concurrency and injected boundary failure tests.
- Cross-yard data or alerts: HTTP authorization and browser session-switch tests.
- Lost/doubled replenishment: repeated planning, inbound coverage and release/rebuild tests.
- Invalid dates/DST and stale reads: parser properties, explicit DST cases and acknowledgement races.
- Migration/compatibility: isolated PostgreSQL migration replay, legacy and neighboring suites.
- Evidence: changed-code coverage, lint/type checks, persisted mutation runner, runtime/browser checks and final report. Record baseline failures and any unavailable layer explicitly.

## Setup

Reuse the existing Node 20/PostgreSQL Docker test project and pinned dev tools. No new dependencies. Preserve the dirty workspace using the captured baseline and a source manifest; no checkpoint commits or production deployment are required by this implementation instruction. Extend the existing gauntlet with a reproducible v2 entry point.
