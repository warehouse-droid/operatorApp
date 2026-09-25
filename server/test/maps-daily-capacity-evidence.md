# Shared daily Maps capacity — evidence

Date: 2026-09-22 UTC.

Specification: [maps-daily-capacity-spec.md](maps-daily-capacity-spec.md).
The user explicitly selected 150 units per UTC day, removal of the embedded-map cap, and a reopening button. Detailed spec approval: not obtained (autonomous run).

## Diagnosis

Read-only production inspection at 22:17 UTC found 651 admitted units in the rolling 30-day window and 63 today. Embedded maps accounted for 300 units (261 automatic, 39 manual), driver geocoding 243, Dispatch routing 103, and support routing 5. Three current map attempts were denied with `subsystem_limit`, while route requests succeeded. This was the application's old map-specific allowance, not evidence of a Google daily quota failure.

## Final behavior

- Every centrally metered Maps feature shares a 150-unit UTC-day limit. The 300-map rolling allowance is removed. The existing rolling hard limit of 4,500 and other mode/reserve safeguards remain.
- Admin Maps Usage displays today's used/limit fraction, percentage, remaining capacity, UTC reset, rolling usage, and feature/action attribution.
- An admin can reopen an exhausted day with up to 150 additional units, capped by remaining rolling capacity. The append-only grant records the request ID, date, actor hash, amount, and time; usage is not reset.
- Repeated IDs are idempotent. A capacity revision and the common admission lock protect against simultaneous or delayed administrator commands. Grants expire at the UTC-day boundary.
- Normal truck-monitor polling reuses the existing map and does not call Google routing. Initial map creation and explicit ETA requests remain metered.

## Verification

Reproducible entry point:

```sh
bash server/tools/maps-daily-capacity-gauntlet.sh
```

The runner uses an internal Docker network and disposable PostgreSQL database. It does not connect test requests to Google or production.

| Layer | Final result |
| --- | --- |
| Complete focused Maps suite | 49 tests: 48 passed, 1 independently reproduced pre-existing failure, zero new failures |
| New tests in a different file order | 18/18 passed |
| Deliberate defects | 7/7 killed: daily guard, old map cap, other automatic caps, duplicate grant, stale revision, expired grant, admin authorization |
| Coverage of changed policy/accounting lines | 89/89 covered: policy 21/21, repository 68/68 |
| Entire measured policy/accounting modules | 98.57% lines/statements, 100% functions, 78.36% branches |
| Syntax and focused ESLint | Passed |
| Secret scan | Passed for all 7 runtime paths |
| Real authenticated HTTP | Anonymous 401, dispatcher 403, admin reopen and idempotent retry passed; hostile amount ignored |
| Real browser execution | Desktop and 390px mobile passed; 150/150 became 150/300 and survived reload; no horizontal page overflow |
| Migration rollback rehearsal | Passed; rolling back the additive migration restored the original grant table and history |

The existing failure is `dispatch rendering and autosave never trigger route API work`: it expects a direct call inside `confirmCurrentPlanAtomic`, which already delegates to `performDispatchPlanConfirmation`. The saved pre-change code reproduces the same failure. That test and Dispatch implementation were not weakened or changed.

During development, the mobile check exposed overflow, which was fixed within Maps Usage. An initial concurrency fixture assumed a particular admin request won the race; it now retries the actual recorded winner without changing the expected single-grant behavior. The coverage runner initially inherited a generic 90% branch setting from the test image; the reproducible command explicitly uses the repository's existing Maps thresholds (95% lines/statements, 90% functions, 75% branches), with a separate 100% changed-line gate for the new accounting/policy code.

Static type checking was not applied to these untyped JavaScript modules; syntax, lint, runtime input validation, property tests, and real PostgreSQL/HTTP checks were used. No dependency set changed. The unrelated whole-application suite was not rerun. UI rendering and the small server-route addition are covered by rendered-output, authenticated HTTP, and browser checks; their changed-line percentage is not claimed.

Frozen runtime source hash: `077ffa0321924378e5f77a6fa82f28851cf175213863854e89fd84f1c51974a1`.
Machine-readable checks, test logs, screenshots, mutation logs, baseline comparison, and coverage are in `server/test-artifacts/maps-daily-capacity/`.

## Acceptance mapping

Scenarios 1–2: daily policy boundary/property tests and retained Maps policy tests. Scenario 3: PostgreSQL accounting/reset tests. Scenario 4: rendered-output and browser tests. Scenarios 5–7: PostgreSQL reopen/concurrency/idempotency/stale-day/global-ceiling tests. Scenario 8: authenticated HTTP, browser, and client retry tests. Scenario 9: existing Maps gateway, replay, privacy, and monitor contract checks (with the unrelated baseline failure identified above).

## Deployment

The release tool prepares a patch over the captured production image and preserves unrelated runtime changes. It verifies source hashes and environment configuration, saves schema/migration backups, applies only migration 219, and restarts only the application. The worker, database, and Ollama containers are preserved. Candidate startup and production health/assets/accounting are checked without making a Google API call or reopening production capacity.

Deployed at **2026-09-22 22:53:57 UTC** as `mbbs-operator-app:maps-daily-capacity-20260922-v1`, image `sha256:3a700463cc4bd445446ff7c58be85b077acdc423220bc4989a039d2ce743d114`.

The exact image passed isolated startup and anonymous-access checks before cutover. After deployment, local/public health, all three public asset hashes, all seven runtime file hashes, migration 219, configuration preservation, and unchanged dependency containers passed. The live counters were **63/150 today, 87 remaining**, and **651/4,500 rolling**, in `normal` mode. Extra capacity was zero: no production reopen or paid Google probe was performed. The release patch preserved unrelated live differences in `server.js`.

Machine-readable result: `server/test-artifacts/maps-daily-capacity-deployment-20260922/deployment-result.json`.
