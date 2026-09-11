# Google Maps Usage Control — Executable Specification

Approved by the user's request to implement the previously reviewed reduction plan on 2026-09-11.

## Goal

Reduce all application-authorized Google Maps Platform usage from the current 48,000-request rate to a normal target of at most 4,000 and a hard application limit of 4,500 usage units per rolling 30 days, leaving 500 units of external-reporting safety margin.

## Acceptance scenarios

1. Dispatch render, re-render, load selection, unrelated edits, and draft save initiate zero Google route requests.
2. Confirming a changed multi-stop load initiates at most one server route request; every physical leg receives a finite preview duration from that response or a deterministic fallback.
3. Confirming an unchanged route fingerprint initiates zero additional Google requests.
4. Dispatch Monitor's ordinary 10-second refresh initiates zero Google Directions requests, regardless of active truck count or open tabs.
5. A selected-truck manual/exception ETA refresh is admitted only within its subsystem/global budget and is coalesced for the same truck/destination for 15 minutes.
6. The rolling budget admits normal work below 4,000, only reserve-eligible work from 4,000 through 4,499, and no work at 4,500; concurrent admission cannot cross the limit.
7. Disabled configuration, exhausted budget, timeout, HTTP error, and invalid Google output return labelled fallback estimates and do not block plan save, driver completion, or photo evidence.
8. Driver photo completion can reuse a recent location-check result and does not require a duplicate geocode.
9. All server-side Google consumers use one accounting boundary; no raw key, address, coordinate, or response content is written to the usage ledger.
10. Browser Maps configuration uses a browser-only key; the server key is never returned by `/api/dispatch/config`.
11. A replay of the most recent seven complete UTC days validates every route preview (ordered stops, finite nonnegative leg/total minutes, stable fingerprint) and compares legacy versus controlled usage on the identical event stream.
12. The replay must project the controlled mechanism below 5,000 requests per 30 days and separately report any malformed saved estimate plus the valid fallback that repairs it, rather than silently omitting the defect.
13. A request denied at capacity is never queued or retried automatically; the caller immediately receives a labelled fallback and only a later explicit action may try again.
14. Admins can view a 30-day daily usage graph plus per-action/API admitted, denied, and failed counts so the highest-usage workflow is identifiable without exposing route data.
15. Every new browser map canvas consumes one central admission, repeated monitor polling does not create canvases or denied ledger traffic, and automatic Dynamic Maps stop at their 300-unit subsystem allowance.
16. Ordinary confirmation and Front Desk distance calls use standard (non-live-traffic) routing; paid live traffic and routes above 10 intermediate stops require an explicit refresh.

## Failure model and proving layers

- Counter race/overshoot: concurrency and property tests around the pure admission policy and repository transaction.
- Off-by-one window/limit: boundary tests plus manual comparison mutants.
- Stale route reused after a meaningful edit: fingerprint property tests.
- UI accidentally calls Google while rendering/polling: frontend source contract tests and replay event classification.
- Multi-leg request multiplication: one-request-per-load unit and replay assertions.
- Missing/invalid stop data: adversarial preview tests proving deterministic fallback and explicit invalid reporting.
- Google outage/quota exhaustion: integration tests proving business operations continue with fallback metadata.
- Multiple tabs: coalescing/cooldown concurrency test.
- Credential leakage/PII telemetry: source contract and diff secret scan.
- Replay selection bias: one shared seven-day event fixture/query drives both legacy and controlled models; totals reconcile to selected rows.

## Setup and artifacts

- Use Node's existing test runner, `c8`, ESLint, PostgreSQL test infrastructure, and existing dependencies only.
- Add production policy/gateway/replay modules, a database migration for usage accounting, targeted unit/property/concurrency/frontend/integration tests, a reproducible seven-day replay command, and a final evidence report.
- Do not install packages, create commits, call Google during tests/replay, deploy, or modify unrelated dirty-worktree changes.

## Invariants

- Existing dispatch, monitoring, SCM, driver, Frontdesk, and billing response shapes remain backward compatible; new estimate metadata is additive.
- Core workflows remain available without any Google key.
- Google-derived content is not persisted as a general-purpose cache; only non-content request metadata and application-owned/fallback calculations are retained.
- The hard usage guard remains enabled during fallback or rollback.
